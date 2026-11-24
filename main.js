const { app, BrowserWindow, Tray, Menu, Notification, nativeImage, nativeTheme, screen, dialog, shell, ipcMain } = require('electron');
const { spawn } = require('child_process');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const G = require('./renderer/geometry.js'); // the opened widget's shape, shared with the page
const usageLib = require('./lib/usage');
const statusline = require('./lib/statusline');
const registry = require('./lib/registry');

// Software rendering: drops the GPU process / shared textures, a big chunk of
// the app's memory footprint. Plenty for a tiny widget with CSS animations.
app.disableHardwareAcceleration();

// Windows shows a toast only for an app id it knows: the installer gives the
// Start Menu shortcut this one (build.appId in package.json).
const APP_ID = 'com.alexyang.claude-stoplight';
if (process.platform === 'win32') app.setAppUserModelId(app.isPackaged ? APP_ID : process.execPath);

// CLAWD_DATA_DIR moves the widget's own files, for running a second copy
// under test. Claude Code keeps its files under CLAUDE_CONFIG_DIR when that is
// set, so the widget looks there too.
const DATA_DIR = process.env.CLAWD_DATA_DIR || path.join(os.homedir(), '.claude-stoplight');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const STATE_PATH = path.join(DATA_DIR, 'state.json');
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const CLAUDE_SETTINGS = path.join(CLAUDE_DIR, 'settings.json');

// CLAWD_SMOKE=<folder>: play a scripted session at ourselves, save what the
// widget showed there, and exit (lib/smoke.js). For checking a build unattended.
const SMOKE = process.env.CLAWD_SMOKE || '';

const MARKER = 'claude-stoplight/event'; // identifies our hook entries inside settings.json
// The window is a square with room for the opened tray, and never resizes:
// resizes can't animate smoothly on Windows. At rest all of it but the lamp
// is fully transparent, and transparent pixels pass mouse events through, so
// it obstructs nothing.
const SIZE_MIN = 70; // widget scale, % (below this the tray's text is too small to read)
const SIZE_MAX = 150;

const DEFAULTS = {
  port: 47615,
  sizePct: 100, // widget scale, SIZE_MIN–SIZE_MAX (%)
  pruneHours: 6, // drop sessions silent this long (terminal killed without SessionEnd)
  dimIdle: false, // fade the widget when green / no sessions
  clickThroughIdle: false, // let clicks pass through the widget when green / no sessions
  notify: true, // a Windows notification when a session has waited on the user notifyAfterSec
  notifyAfterSec: 30,
  notifySound: false, // play the Windows notification sound with it
  statusLine: true, // read plan usage from Claude Code's status line (see lib/statusline.js)
};

// Hook events we subscribe to. The tool events take a tool matcher. The tool
// hooks fire on every tool call, so they run async: Claude doesn't wait for
// them (a hook that blocks costs about 80 ms on Windows, twice per tool call).
// The once-per-turn hooks stay synchronous, so they reach us in order; see
// isStraggler for the async ones.
const HOOK_EVENTS = [
  { event: 'SessionStart' },
  { event: 'UserPromptSubmit' },
  { event: 'PreToolUse', matcher: '*', async: true },
  { event: 'PostToolUse', matcher: '*', async: true },
  { event: 'PostToolUseFailure', matcher: '*', async: true },
  { event: 'PermissionRequest', matcher: '*' },
  { event: 'PermissionDenied' },
  { event: 'Notification' },
  { event: 'Stop' },
  { event: 'SessionEnd' },
];
const ASYNC_EVENTS = new Set(HOOK_EVENTS.filter((h) => h.async).map((h) => h.event));
// An async tool event this soon after a session turned red or green is a
// straggler that started before that change (see isStraggler).
const STRAGGLER_MS = 2000;

// Notification types that mean "Claude is blocked waiting on the user".
const BLOCKED_NOTIFICATIONS = new Set([
  'permission_prompt',
  'elicitation_dialog',
  'elicitation_url_dialog',
  'agent_needs_input',
]);

// Session discovery and liveness. Hook payloads carry no process id, but
// Claude Code keeps a registry of its running processes in
// ~/.claude/sessions/<pid>.json (session id, cwd, process start time, and a
// coarse idle/busy status). syncSessions() reads it on a timer and whenever the
// folder changes, so a session that was already running (or idle) when the
// widget started shows up without waiting for its next hook event, every
// session gets its pid the moment it is first seen, and a session whose process
// is gone is dropped instead of lingering until pruned.
const CLAUDE_SESSIONS_DIR = path.join(CLAUDE_DIR, 'sessions');
const LIVENESS_MS = 20 * 1000;
const SYNC_DEBOUNCE_MS = 400; // after a change in the sessions folder
const REAP_GUARD_MS = 2 * 60 * 1000; // events from a just-reaped id disable its pid tracking
// While the widget was down it may have missed SessionEnd, so on load a record
// with no process to verify is only restored if it was heard from recently; a
// live session comes back by itself on its next hook event or the first sync.
const RESTORE_UNVERIFIED_MS = 10 * 60 * 1000;
// A session tied to a process outlives pruneHours: the sync drops it when the
// process exits. If the process list has been unreadable this long, pruning
// goes back to the timeout so a dead session can't hold the light forever.
const PROCESS_LIST_STALE_MS = 5 * 60 * 1000;
// A widget edge this close to a work-area edge counts as docked to it, and
// follows that edge when the work area changes (taskbar hidden, resized...).
const DOCK_TOL = 12;
const DOCK_MIGRATE_TOL = 64; // once, for positions saved before docking existed

// Plan usage (the same numbers as Claude Code's /usage). Where the figures
// come from, and how seldom the endpoint is asked, is lib/usage.js.
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CLAUDE_CREDENTIALS = path.join(CLAUDE_DIR, '.credentials.json');
const USAGE_PATH = path.join(DATA_DIR, 'usage.json');
const USAGE_TIMER_MS = 10 * 60 * 1000;
const USAGE_TIMEOUT_MS = 10 * 1000;
// A status line from a session heard from this recently carries current figures.
const STATUS_FRESH_MS = 2 * 60 * 1000;

// A turn that ran at least this long earns Clawd a celebratory hop when it ends.
const LONG_TURN_MS = 60 * 1000;
// A finished turn stays marked until the session panel has been open this long.
const SEEN_MS = 800;
// Longest description of a tool call or background task kept for display.
const DETAIL_MAX = 120;

let win = null;
let ownerWin = null; // invisible owner window, see createWindow
let tray = null;
let server = null;
let settingsWin = null;
let config = Object.assign({}, DEFAULTS);
// session_id -> { state: 'ready'|'working'|'permission', since, lastEvent, cwd,
//                 tool (last PreToolUse tool_name), waitKind ('permission'|'question'),
//                 detail (that tool call in a few words, or the question asked),
//                 bg (background tasks still running at the last Stop) and bgSince,
//                 unreadAt (when a turn finished that the user has not looked at yet),
//                 turnStart (last UserPromptSubmit),
//                 name/nameSource (the registry's session name, and whether it was
//                   derived from the folder or chosen with /rename),
//                 pid/pname/pstart (Claude Code process, once known),
//                 noPid (true: never trust the registry's pid for this id again),
//                 registryOnly (true: found through the registry, and no hook
//                   event has been heard from it yet; see lib/registry.js) }
const sessions = new Map();
// session_id -> when syncSessions dropped it (guards against a wrong pid flapping)
const reaped = new Map();

// ---------------------------------------------------------------- config/state

function readJson(file) {
  try {
    // (some Windows editors save UTF-8 with a byte-order mark, which JSON.parse refuses)
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

function clampInt(v, lo, hi, dflt) {
  v = Math.round(Number(v));
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt;
}

function loadConfig() {
  config = Object.assign({}, DEFAULTS, readJson(CONFIG_PATH) || {});
  config.port = clampInt(config.port, 1024, 65535, DEFAULTS.port);
  config.sizePct = clampInt(config.sizePct, SIZE_MIN, SIZE_MAX, DEFAULTS.sizePct);
  config.pruneHours = clampInt(config.pruneHours, 1, 168, DEFAULTS.pruneHours);
  config.notifyAfterSec = clampInt(config.notifyAfterSec, 0, 3600, DEFAULTS.notifyAfterSec);
  config.statusLine = config.statusLine !== false;
}

function saveConfig() {
  try {
    writeJson(CONFIG_PATH, config);
  } catch {}
}

// design units (see renderer/geometry.js) to screen px
function scale() {
  return config.sizePct / 100;
}

// the window's side
function winSize() {
  return Math.round(G.WINDOW * scale());
}

function loadSessions() {
  const saved = readJson(STATE_PATH);
  if (saved && Array.isArray(saved.sessions)) {
    const now = Date.now();
    for (const [id, s] of saved.sessions) {
      if (!s || typeof s.state !== 'string') continue;
      const lastEvent = s.lastEvent || s.t || 0;
      if (typeof s.pid !== 'number' && now - lastEvent > RESTORE_UNVERIFIED_MS) continue;
      // migrate pre-1.1 records that only had a single timestamp `t`
      sessions.set(id, {
        state: s.state,
        since: s.since || s.t || Date.now(),
        lastEvent: s.lastEvent || s.t || Date.now(),
        cwd: typeof s.cwd === 'string' ? s.cwd : null,
        tool: typeof s.tool === 'string' ? s.tool : null,
        waitKind: s.state !== 'permission' ? null : s.waitKind === 'question' ? 'question' : 'permission',
        turnStart: typeof s.turnStart === 'number' ? s.turnStart : null,
        name: typeof s.name === 'string' ? s.name : null,
        nameSource: typeof s.nameSource === 'string' ? s.nameSource : null,
        pid: typeof s.pid === 'number' ? s.pid : null,
        pname: typeof s.pname === 'string' ? s.pname : null,
        pstart: typeof s.pstart === 'number' ? s.pstart : null,
        noPid: s.noPid === true,
      });
    }
    pruneSessions();
  }
}

let persistTimer = null;
function persistSessions() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    // what a session is doing right now is not worth keeping, and leaves the
    // commands it ran out of the file
    const kept = [...sessions.entries()].map(([id, s]) => [id, Object.assign({}, s, { detail: undefined, bg: undefined })]);
    try {
      writeJson(STATE_PATH, { sessions: kept });
    } catch {}
  }, 400);
}

// ---------------------------------------------------------------- aggregation

function aggregate() {
  if (sessions.size === 0) return 'off';
  let state = 'ready';
  for (const s of sessions.values()) {
    if (s.state === 'permission') return 'permission';
    if (s.state === 'working') state = 'working';
  }
  return state;
}

const STATE_LABELS = {
  off: 'No Claude sessions',
  ready: 'Claude is ready',
  working: 'Claude is working…',
  permission: 'Claude needs you!',
};

const STATE_ORDER = { permission: 0, working: 1, ready: 2 };

function folderName(cwd) {
  return (cwd && path.basename(cwd)) || null;
}

// What each session is called in the widget and in notifications: the name
// given with /rename if there is one, else the project folder. Two sessions in
// the same folder would read alike, so those show the registry's own names
// instead (e.g. alex-obsidian-e7 and alex-obsidian-ec).
function sessionLabels() {
  const base = new Map();
  for (const [id, s] of sessions) {
    const chosen = Boolean(s.name && s.nameSource && s.nameSource !== 'derived');
    base.set(id, { chosen, label: chosen ? s.name : folderName(s.cwd) || s.name || `session ${id.slice(0, 8)}` });
  }
  const count = new Map();
  for (const b of base.values()) count.set(b.label, (count.get(b.label) || 0) + 1);
  const labels = new Map();
  for (const [id, b] of base) {
    const s = sessions.get(id);
    let label = b.label;
    if (count.get(label) > 1 && !b.chosen) label = s.name && s.name !== label ? s.name : `${label} · ${id.slice(0, 4)}`;
    labels.set(id, label);
  }
  return labels;
}

function sessionList() {
  const labels = sessionLabels();
  return [...sessions.entries()]
    .map(([id, s]) => ({
      id,
      label: labels.get(id),
      state: s.state,
      since: s.since,
      lastEvent: s.lastEvent,
      cwd: s.cwd,
      tool: s.tool,
      waitKind: s.waitKind,
      detail: s.detail || null,
      bg: s.bg || null,
      bgSince: s.bgSince || null,
      unread: Boolean(s.unreadAt),
    }))
    .sort((a, b) => (STATE_ORDER[a.state] - STATE_ORDER[b.state]) || (a.since - b.since));
}

// One-shot Clawd reaction in the widget ('done' -> hop, 'flinch').
function react(type) {
  if (win && !win.isDestroyed()) win.webContents.send('react', { type });
}

function pushState() {
  const state = aggregate();
  if (win && !win.isDestroyed()) {
    win.webContents.send('state', { state, sessions: sessionList() });
  }
  if (tray) {
    const n = sessions.size;
    const suffix = n ? ` (${n} session${n === 1 ? '' : 's'})` : '';
    tray.setToolTip(`Clawd — ${STATE_LABELS[state]}${suffix}`);
  }
  applyQuietMode(state);
  updateToasts();
}

function applyQuietMode(state) {
  if (!win || win.isDestroyed()) return;
  const idle = state === 'ready' || state === 'off';
  // forward:true keeps mousemove flowing to the page so hover-expand still works
  win.setIgnoreMouseEvents(Boolean(idle && config.clickThroughIdle), { forward: true });
}

function setSession(id, state, payload, patch) {
  const now = Date.now();
  const prev = sessions.get(id) || {};
  const cwd = (payload && typeof payload.cwd === 'string' && payload.cwd) || prev.cwd || null;
  let noPid = prev.noPid === true;
  if (!prev.state && reaped.has(id)) {
    // an id we just declared dead is still sending events: its recorded process
    // was wrong, so never track a pid for it again (pruneHours still applies)
    if (now - reaped.get(id) < REAP_GUARD_MS) noPid = true;
    reaped.delete(id);
  }
  // (a new record, so one found through the registry stops being registryOnly
  // with its first hook event)
  sessions.set(
    id,
    Object.assign(
      {
        state,
        since: prev.state === state ? prev.since : now,
        lastEvent: now,
        cwd,
        tool: prev.tool || null,
        waitKind: state === 'permission' ? prev.waitKind || 'permission' : null,
        detail: prev.detail || null,
        bg: prev.bg || null,
        bgSince: prev.bgSince || null,
        unreadAt: prev.unreadAt || null,
        turnStart: prev.turnStart || null,
        name: prev.name || null,
        nameSource: prev.nameSource || null,
        pid: prev.pid || null,
        pname: prev.pname || null,
        pstart: prev.pstart || null,
        noPid,
      },
      patch
    )
  );
  if (!prev.pid && !noPid) identifySession(id);
  persistSessions();
  pushState();
}

function toolName(payload) {
  return payload && typeof payload.tool_name === 'string' ? payload.tool_name : null;
}

function nonBlank(v) {
  return typeof v === 'string' && v.trim() ? v : null;
}

// one line, at most DETAIL_MAX characters
function clip(s) {
  const line = String(s).replace(/\s+/g, ' ').trim();
  return line.length > DETAIL_MAX ? `${line.slice(0, DETAIL_MAX - 1)}…` : line;
}

// The first of these a tool's input has says what the call is about: the
// command for Bash, the file for Read / Edit / Write, the pattern for Grep...
const DETAIL_KEYS = ['command', 'file_path', 'notebook_path', 'pattern', 'url', 'query', 'description', 'skill', 'path', 'prompt'];
const FILE_KEYS = new Set(['file_path', 'notebook_path', 'path']);

// "Bash: npm publish", "Edit: main.js", "github: create_issue"; for a question,
// the question itself.
function toolDetail(payload) {
  const tool = toolName(payload);
  if (!tool) return null;
  const input = payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {};
  if (tool === 'AskUserQuestion') {
    const q = Array.isArray(input.questions) ? input.questions[0] : null;
    return q && nonBlank(q.question) ? clip(q.question) : null;
  }
  if (tool === 'ExitPlanMode') return 'a plan to review';
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool);
  const label = mcp ? `${mcp[1]}: ${mcp[2]}` : tool;
  for (const key of DETAIL_KEYS) {
    let v = nonBlank(input[key]);
    if (!v) continue;
    if (FILE_KEYS.has(key)) v = path.basename(v) || v;
    else if (key === 'url') {
      try {
        v = new URL(v).host || v;
      } catch {}
    }
    return `${label}: ${clip(v)}`;
  }
  return label;
}

// Background tasks still in flight when a turn ends (Stop's background_tasks):
// the session is idle, but they can wake it back up when they finish.
const TASK_OVER = /^(completed?|done|failed|error|killed|stopped|cancell?ed)$/i;

function backgroundTasks(payload) {
  const list = payload && Array.isArray(payload.background_tasks) ? payload.background_tasks : [];
  const tasks = [];
  for (const t of list) {
    if (!t || typeof t !== 'object' || TASK_OVER.test(String(t.status || ''))) continue;
    const type = nonBlank(t.type) || 'task';
    const what = nonBlank(t.command) || nonBlank(t.description) || nonBlank(t.name) || nonBlank(t.agent_type) || nonBlank(t.tool);
    tasks.push(what ? `${type}: ${clip(what)}` : type);
    if (tasks.length === 20) break;
  }
  return tasks.length ? tasks : null;
}

// pruneHours is the fallback for sessions the liveness sync can't vouch for.
// An idle session sends no hooks, so judging a live process by its last event
// would drop it every pruneHours, only for the next sync to rediscover it.
function pruneSessions() {
  const cutoff = Date.now() - config.pruneHours * 60 * 60 * 1000;
  const verified = pidsVerifiable();
  let changed = false;
  for (const [id, s] of sessions) {
    if (s.pid && verified) continue;
    if (!s.lastEvent || s.lastEvent < cutoff) {
      sessions.delete(id);
      changed = true;
    }
  }
  if (changed) {
    persistSessions();
    pushState();
  }
}

// ---------------------------------------------------------------- hook events

// The tool hooks run async (see HOOK_EVENTS), so their POSTs can land after a
// newer synchronous one: a PreToolUse just after the PermissionRequest it
// preceded, or the turn's last PostToolUse just after its Stop. Such a
// straggler must not turn a red or green light back to yellow. A real tool
// event this soon after either change is rare, and the registry sync corrects
// the light if one is dropped.
function isStraggler(current, now) {
  return Boolean(
    current &&
      (current.state === 'permission' || current.state === 'ready') &&
      now - current.since < STRAGGLER_MS
  );
}

function handleEvent(event, payload) {
  // without a session id there is nothing to file the event under; a made-up
  // id would be a session no process backs, holding the light for pruneHours
  const id = payload && typeof payload.session_id === 'string' && payload.session_id;
  if (!id) return;
  const current = sessions.get(id);
  const now = Date.now();
  if (ASYNC_EVENTS.has(event) && isStraggler(current, now)) return;
  switch (event) {
    case 'SessionStart':
      setSession(id, 'ready', payload, { tool: null, turnStart: null, detail: null, bg: null, bgSince: null, unreadAt: null });
      break;
    case 'UserPromptSubmit':
      // a new prompt means the user has seen how the last turn ended
      setSession(id, 'working', payload, { tool: null, turnStart: now, detail: null, unreadAt: null });
      break;
    case 'PreToolUse':
      setSession(id, 'working', payload, { tool: toolName(payload), detail: toolDetail(payload) });
      break;
    case 'PostToolUse':
    case 'PostToolUseFailure':
      // the tool has run, so a permission wait for it is long over
      setSession(id, 'working', payload);
      break;
    case 'PermissionDenied':
      setSession(id, 'working', payload);
      react('flinch');
      break;
    case 'PermissionRequest':
      setSession(id, 'permission', payload, {
        waitKind: 'permission',
        tool: toolName(payload) || (current && current.tool) || null,
        detail: toolDetail(payload) || (current && current.detail) || null,
      });
      break;
    case 'Notification': {
      const type = payload && payload.notification_type;
      if (BLOCKED_NOTIFICATIONS.has(type)) {
        // a permission prompt gets the stop sign; a question gets a shrug. For a
        // permission prompt, or a question Claude asked with AskUserQuestion,
        // the tool call behind it says more than the notification's generic
        // message; any other question is best put in its own words.
        const message = nonBlank(payload.message) ? clip(payload.message) : null;
        const prior = (current && current.detail) || null;
        const toolSaysMore = type === 'permission_prompt' || Boolean(current && current.tool === 'AskUserQuestion');
        setSession(id, 'permission', payload, {
          waitKind: type === 'permission_prompt' ? 'permission' : 'question',
          detail: toolSaysMore ? prior || message : message || prior,
        });
      } else if (type === 'idle_prompt' && (!current || current.state !== 'permission')) {
        setSession(id, 'ready', payload, { tool: null, turnStart: null, detail: null });
      }
      break;
    }
    case 'Stop': {
      const longTurn = Boolean(
        current && current.turnStart && now - current.turnStart >= LONG_TURN_MS
      );
      setSession(id, 'ready', payload, {
        tool: null,
        turnStart: null,
        detail: null,
        bg: backgroundTasks(payload),
        bgSince: now,
        // a turn just ended: its result waits until the user looks
        unreadAt: !current || current.state !== 'ready' ? now : current.unreadAt || null,
      });
      if (longTurn) react('done');
      refreshUsage('stop'); // the turn has moved the figures only the endpoint has
      break;
    }
    case 'SessionEnd':
      sessions.delete(id);
      persistSessions();
      pushState();
      break;
  }
}

const MAX_BODY = 1024 * 1024;

// Hooks post with curl, which sends no Origin header and names 127.0.0.1 as
// the host. A browser always sends Origin on a cross-site POST, and a
// DNS-rebinding page arrives under its own host name, so refusing both keeps
// web pages from feeding the widget fake sessions.
function fromHook(req) {
  const host = String(req.headers.host || '').toLowerCase();
  return (
    req.headers.origin === undefined &&
    (host === `127.0.0.1:${config.port}` || host === `localhost:${config.port}`)
  );
}

// Claude Code puts these fields at the start of every hook payload, ahead of
// the tool input and output, so they can still be read from a payload too big
// to keep whole (a Write of a large file, say).
const HEAD_FIELDS = ['session_id', 'cwd', 'tool_name', 'notification_type'];

function salvagePayload(text) {
  const head = text.slice(0, 64 * 1024);
  const payload = {};
  for (const key of HEAD_FIELDS) {
    const m = new RegExp(`"${key}"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*")`).exec(head);
    if (!m) continue;
    try {
      payload[key] = JSON.parse(m[1]);
    } catch {}
  }
  return payload;
}

function startServer() {
  server = http.createServer((req, res) => {
    const url = req.url || '';
    const match = /^\/claude-stoplight\/event\/([A-Za-z]+)$/.exec(url);
    const fromStatusLine = url === statusline.ROUTE;
    if ((!match && !fromStatusLine) || req.method !== 'POST') {
      res.statusCode = 404;
      res.end();
      return;
    }
    if (!fromHook(req)) {
      res.statusCode = 403;
      res.end();
      return;
    }
    req.setEncoding('utf8');
    let body = '';
    let truncated = false;
    req.on('data', (chunk) => {
      if (body.length < MAX_BODY) body += chunk;
      else truncated = true;
    });
    req.on('end', () => {
      let payload = null;
      if (!truncated) {
        try {
          payload = JSON.parse(body);
        } catch {}
      }
      if (fromStatusLine) {
        // the status line command prints whatever comes back, so nothing does
        try {
          if (payload && typeof payload === 'object') handleStatusLine(payload);
        } catch {}
        res.statusCode = 204;
        res.end();
        return;
      }
      if (!payload || typeof payload !== 'object') payload = salvagePayload(body);
      try {
        handleEvent(match[1], payload);
      } catch {}
      res.statusCode = 200;
      res.end('ok');
    });
    req.on('error', () => {});
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      dialog.showErrorBox(
        'Clawd',
        `Port ${config.port} is already in use, so hook events can't be received.\n` +
          `Pick a different port in Settings (tray menu) and hooks will be reinstalled automatically.`
      );
    } else {
      livenessLog(`server error: ${err && err.message}`);
    }
  });
  server.listen(config.port, '127.0.0.1');
}

function restartServer() {
  try {
    if (server) server.close();
  } catch {}
  startServer();
}

// ---------------------------------------------------------------- liveness

// Small diagnostic trail for the session machinery (each discovery, pid
// attach and drop), since none of it is visible from the widget itself.
const LIVENESS_LOG = path.join(DATA_DIR, 'liveness.log');
function livenessLog(msg) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    try {
      if (fs.statSync(LIVENESS_LOG).size > 256 * 1024) fs.unlinkSync(LIVENESS_LOG);
    } catch {}
    fs.appendFileSync(LIVENESS_LOG, `${new Date().toISOString()} ${msg}\n`);
  } catch {}
}

// Windows FILETIME (100 ns ticks since 1601, as a decimal string) -> epoch ms
function filetimeToMs(v) {
  try {
    const t = BigInt(String(v));
    if (t <= 0n) return null;
    return Number(t / 10000n) - 11644473600000;
  } catch {
    return null;
  }
}

// Claude Code's process registry: ~/.claude/sessions/<pid>.json, one file per
// running process, rewritten when its session id or idle/busy status changes
// and removed when the process exits normally.
function readSessionRegistry() {
  const byId = new Map();
  const byPid = new Map();
  let names = [];
  try {
    names = fs.readdirSync(CLAUDE_SESSIONS_DIR);
  } catch {
    return { byId, byPid };
  }
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue;
    const j = readJson(path.join(CLAUDE_SESSIONS_DIR, name));
    if (!j || typeof j.sessionId !== 'string' || !Number.isInteger(j.pid) || j.pid <= 0) continue;
    const rec = {
      id: j.sessionId,
      pid: j.pid,
      cwd: typeof j.cwd === 'string' && j.cwd ? j.cwd : null,
      startedAt: typeof j.startedAt === 'number' ? j.startedAt : null,
      pstart: filetimeToMs(j.procStart),
      status: typeof j.status === 'string' ? j.status : null,
      statusAt: typeof j.statusUpdatedAt === 'number' ? j.statusUpdatedAt : null,
      waitingFor: typeof j.waitingFor === 'string' ? j.waitingFor : null,
      name: typeof j.name === 'string' && j.name.trim() ? j.name.trim() : null,
      nameSource: typeof j.nameSource === 'string' ? j.nameSource : null,
    };
    byId.set(rec.id, rec);
    byPid.set(rec.pid, rec);
  }
  return { byId, byPid };
}

function attachProcess(id, s, rec, names) {
  s.pid = rec.pid;
  s.pstart = rec.pstart;
  s.pname = (names && names.get(rec.pid)) || null;
  if (!s.cwd && rec.cwd) s.cwd = rec.cwd;
  applyRegistryName(s, rec);
  livenessLog(`attach ${String(id).slice(0, 8)} pid=${rec.pid}`);
}

// The session's name in the registry: derived from the folder at first, then
// whatever /rename sets. Returns true when it changed.
function applyRegistryName(s, rec) {
  if (!rec.name || (s.name === rec.name && s.nameSource === rec.nameSource)) return false;
  s.name = rec.name;
  s.nameSource = rec.nameSource;
  return true;
}

// Attach the registry's process to a session we just heard from. Hooks can
// arrive several times a second, so the registry read is cached briefly.
let registryCache = null; // { at, reg }
function identifySession(id) {
  const s = sessions.get(id);
  if (!s || s.pid || s.noPid) return;
  const now = Date.now();
  if (!registryCache || now - registryCache.at > 1000) {
    registryCache = { at: now, reg: readSessionRegistry() };
  }
  const rec = registryCache.reg.byId.get(id);
  if (rec) attachProcess(id, s, rec, null);
}

// pid -> lowercase image name for every running process, or null on failure
function listProcesses(cb) {
  let out = '';
  let child;
  try {
    child = spawn('tasklist.exe', ['/FO', 'CSV', '/NH'], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    cb(null);
    return;
  }
  child.stdout.on('data', (chunk) => {
    out += chunk;
  });
  child.on('error', () => cb(null));
  child.on('close', (code) => {
    if (code !== 0) {
      cb(null);
      return;
    }
    const map = new Map();
    for (const line of out.split(/\r?\n/)) {
      const m = /^"([^"]+)","(\d+)"/.exec(line);
      if (m) map.set(Number(m[2]), m[1].toLowerCase());
    }
    cb(map.size ? map : null);
  });
}

let syncBusy = false;
let syncAgain = false;
let processListAt = 0; // when listProcesses last succeeded
const appStartedAt = Date.now();

// True while the sync can tell a live process from a dead one: the process
// list was read recently, or the app has only just started and is about to.
function pidsVerifiable() {
  if (process.platform !== 'win32') return false;
  return Date.now() - (processListAt || appStartedAt) < PROCESS_LIST_STALE_MS;
}

// Reconcile our sessions with the registry and the process list:
//  - drop a session whose process is gone (the same pid under a different image
//    name means the pid was recycled; a process that started before the current
//    boot cannot be alive — its pid survived in state.json across a reboot) or
//    whose process has moved on to another session id (/clear, /resume);
//  - add live registry sessions we have never heard from (already running, or
//    sitting idle, when the widget started), with the registry's idle/busy
//    state, or as ready when the registry gives none (lib/registry.js);
//  - attach pids to sessions that still lack one;
//  - correct drift between working and ready when the registry's status is
//    newer than our last hook event (a Stop or prompt we missed), or whenever
//    it differs for a session no hook event has come from yet;
//  - follow permission waits: Claude Code marks a session `waiting` while a
//    dialog (permission prompt, question) is up and flips it back the moment
//    the dialog is answered, so the light turns from red as soon as a prompt
//    is approved instead of at the next hook event (which, for a long
//    command, is only when it finishes).
function syncSessions() {
  if (process.platform !== 'win32') return;
  try {
    quickWaitSync();
  } catch (err) {
    livenessLog(`quick sync failed: ${err && err.message}`);
  }
  if (syncBusy) {
    syncAgain = true;
    return;
  }
  syncBusy = true;
  const bootTime = Date.now() - os.uptime() * 1000;
  listProcesses((names) => {
    syncBusy = false;
    if (names) {
      processListAt = Date.now();
      try {
        reconcileSessions(names, bootTime);
      } catch (err) {
        livenessLog(`sync failed: ${err && err.message}`);
      }
    }
    if (syncAgain) {
      syncAgain = false;
      setTimeout(syncSessions, 500);
    }
  });
}

// Follow a dialog through the registry (see syncSessions): a session marked
// `waiting` is blocked on the user; a newer non-waiting status means the
// dialog has been answered. Returns true when the session changed.
function applyRegistryWait(id, s, rec) {
  if (!rec.status || !rec.statusAt) return false;
  if (s.state === 'permission') {
    if (rec.status === 'waiting' || rec.statusAt <= s.since + 500) return false;
    const idle = rec.status === 'idle';
    Object.assign(
      s,
      idle
        ? { state: 'ready', since: rec.statusAt, tool: null, waitKind: null, turnStart: null, detail: null }
        : { state: 'working', since: rec.statusAt, waitKind: null }
    );
    livenessLog(`drift ${String(id).slice(0, 8)} permission -> ${s.state} (registry ${rec.status})`);
    return true;
  }
  // a dialog opened after our last hook event (e.g. a question, which has no
  // hook of its own; permission prompts usually get here via their hook
  // first). A menu the user opened themselves (e.g. /config) is not Claude
  // waiting on them.
  if (rec.status !== 'waiting' || rec.statusAt <= s.lastEvent || rec.waitingFor === 'dialog open') return false;
  const question = !/permission|sandbox|worker/i.test(rec.waitingFor || '');
  Object.assign(s, { state: 'permission', since: rec.statusAt, waitKind: question ? 'question' : 'permission' });
  livenessLog(`drift ${String(id).slice(0, 8)} -> permission (registry waiting: ${rec.waitingFor || '?'})`);
  return true;
}

// The cheap half of a sync: no process listing, just the registry, so a
// prompt being answered reaches the light without waiting on tasklist.
function quickWaitSync() {
  const reg = readSessionRegistry();
  registryCache = { at: Date.now(), reg };
  let changed = false;
  for (const [id, s] of sessions) {
    const rec = reg.byId.get(id);
    if (!rec) continue;
    if (applyRegistryWait(id, s, rec)) changed = true;
    if (applyRegistryName(s, rec)) changed = true;
  }
  if (changed) {
    persistSessions();
    pushState();
  }
}

let settleTimer = null; // a sync for records too new to judge, see reconcileSessions
function reconcileSessions(names, bootTime) {
  const reg = readSessionRegistry();
  registryCache = { at: Date.now(), reg };
  const now = Date.now();
  let changed = false;
  const alive = (pid, pname, pstart) =>
    names.has(pid) && (!pname || names.get(pid) === pname) && !(pstart && pstart < bootTime - 5000);
  for (const [id, s] of [...sessions.entries()]) {
    const rec = reg.byId.get(id);
    if (!s.pid && !s.noPid && rec) {
      attachProcess(id, s, rec, names);
      changed = true;
    }
    if (s.pid) {
      if (!s.pname && names.has(s.pid)) {
        s.pname = names.get(s.pid);
        changed = true;
      }
      const other = reg.byPid.get(s.pid);
      const replaced = Boolean(other && other.id !== id);
      if (replaced || !alive(s.pid, s.pname, s.pstart)) {
        livenessLog(
          `drop ${String(id).slice(0, 8)} pid=${s.pid} now=${names.get(s.pid) || 'gone'} was=${s.pname || '?'}` +
            (replaced ? ` (process moved on to ${other.id.slice(0, 8)})` : '')
        );
        sessions.delete(id);
        reaped.set(id, now);
        changed = true;
        continue;
      }
    }
    if (rec && applyRegistryName(s, rec)) changed = true;
    if (rec && applyRegistryWait(id, s, rec)) {
      changed = true;
    } else if (rec) {
      const fix = registry.drift(s, rec);
      if (fix) {
        livenessLog(`drift ${String(id).slice(0, 8)} ${s.state} -> ${fix.state} (registry ${rec.status})`);
        Object.assign(s, fix);
        changed = true;
      }
    }
  }
  let settleIn = 0; // until the first of the records held back below is old enough
  for (const rec of reg.byId.values()) {
    if (sessions.has(rec.id) || !alive(rec.pid, null, rec.pstart)) continue;
    if (reaped.has(rec.id) && now - reaped.get(rec.id) < REAP_GUARD_MS) continue;
    const found = registry.discover(rec, now);
    if (found.wait) {
      settleIn = settleIn ? Math.min(settleIn, found.wait) : found.wait;
      continue;
    }
    sessions.set(
      rec.id,
      Object.assign(
        {
          cwd: rec.cwd,
          tool: null,
          waitKind: null,
          detail: null,
          bg: null,
          bgSince: null,
          unreadAt: null,
          name: rec.name,
          nameSource: rec.nameSource,
          pid: rec.pid,
          pname: names.get(rec.pid) || null,
          pstart: rec.pstart,
          noPid: false,
        },
        found // state, since, lastEvent, turnStart, registryOnly
      )
    );
    livenessLog(`discover ${rec.id.slice(0, 8)} pid=${rec.pid} status=${rec.status || '?'}`);
    changed = true;
  }
  // A record held back gets no second look from the folder watcher unless its
  // file changes again, so come back for it instead of leaving it to the timer.
  clearTimeout(settleTimer);
  if (settleIn) settleTimer = setTimeout(syncSessions, settleIn);
  if (changed) {
    persistSessions();
    pushState();
  }
}

// Sync soon after the registry folder changes (a session starts, ends, or
// flips between idle and busy), so the light follows within a second.
let watchTimer = null;
function watchSessionsDir() {
  try {
    fs.mkdirSync(CLAUDE_SESSIONS_DIR, { recursive: true });
    const w = fs.watch(CLAUDE_SESSIONS_DIR, { persistent: false }, () => {
      clearTimeout(watchTimer);
      watchTimer = setTimeout(syncSessions, SYNC_DEBOUNCE_MS);
    });
    w.on('error', (err) => livenessLog(`watch error: ${err && err.message}`));
  } catch (err) {
    livenessLog(`watch failed: ${err && err.message}`);
  }
}

// ---------------------------------------------------------------- hooks install

function hookCommand(event) {
  return (
    `curl.exe -s -o NUL -m 1 -X POST --data-binary "@-" ` +
    `http://127.0.0.1:${config.port}/claude-stoplight/event/${event} ; exit 0`
  );
}

// The settings.json entry for one of HOOK_EVENTS.
function hookEntry({ event, matcher, async }) {
  const hook = { type: 'command', command: hookCommand(event), timeout: 5 };
  if (async) hook.async = true;
  return matcher ? { matcher, hooks: [hook] } : { hooks: [hook] };
}

function isOurs(group) {
  return (group.hooks || []).some(
    (h) => typeof h.command === 'string' && h.command.includes(MARKER)
  );
}

// Field by field rather than as text: Claude Code may reorder the keys when it
// rewrites settings.json.
function isCurrentEntry(group, spec) {
  const want = hookEntry(spec);
  const hooks = group.hooks || [];
  const h = hooks[0] || {};
  const w = want.hooks[0];
  return (
    hooks.length === 1 &&
    (group.matcher || undefined) === want.matcher &&
    h.type === w.type &&
    h.command === w.command &&
    h.timeout === w.timeout &&
    Boolean(h.async) === Boolean(w.async)
  );
}

function hooksInstalled() {
  const settings = readJson(CLAUDE_SETTINGS);
  if (!settings || !settings.hooks) return false;
  return Object.values(settings.hooks).some(
    (groups) => Array.isArray(groups) && groups.some(isOurs)
  );
}

// true when every event we subscribe to carries exactly the hook installHooks
// writes now (an older install may predate some events, the async tool hooks,
// or a port change)
function hooksComplete() {
  const settings = readJson(CLAUDE_SETTINGS);
  if (!settings || !settings.hooks) return false;
  return HOOK_EVENTS.every((spec) => {
    const groups = settings.hooks[spec.event];
    const ours = Array.isArray(groups) ? groups.filter(isOurs) : [];
    return ours.length === 1 && isCurrentEntry(ours[0], spec);
  });
}

// a timestamped copy beside settings.json, before each change we make to it
function backupClaudeSettings() {
  try {
    fs.copyFileSync(CLAUDE_SETTINGS, `${CLAUDE_SETTINGS}.backup-stoplight-${Date.now()}`);
  } catch {}
}

function installHooks(interactive) {
  let settings = {};
  if (fs.existsSync(CLAUDE_SETTINGS)) {
    settings = readJson(CLAUDE_SETTINGS);
    if (settings === null) {
      dialog.showErrorBox(
        'Clawd',
        `${CLAUDE_SETTINGS} could not be parsed as JSON, so hooks were NOT installed. ` +
          `Fix the file and use "Install Claude Code hooks" in the tray menu.`
      );
      return false;
    }
    backupClaudeSettings();
  }
  settings.hooks = settings.hooks || {};
  for (const spec of HOOK_EVENTS) {
    const groups = settings.hooks[spec.event] || [];
    // drop any stale entries of ours (e.g. old port), then add the current one
    settings.hooks[spec.event] = groups.filter((g) => !isOurs(g)).concat(hookEntry(spec));
  }
  try {
    writeJson(CLAUDE_SETTINGS, settings);
  } catch (err) {
    dialog.showErrorBox('Clawd', `Could not write ${CLAUDE_SETTINGS}: ${err.message}`);
    return false;
  }
  if (interactive) {
    dialog.showMessageBox({
      type: 'info',
      title: 'Clawd',
      message: 'Claude Code hooks installed.',
      detail:
        'Claude Code sessions will now report their status to the widget. ' +
        'Sessions already running normally pick the new hooks up by themselves; restart one if it does not.',
    });
  }
  return true;
}

function removeHooks(interactive) {
  const settings = readJson(CLAUDE_SETTINGS);
  if (!settings || !settings.hooks) return;
  for (const event of Object.keys(settings.hooks)) {
    if (!Array.isArray(settings.hooks[event])) continue;
    settings.hooks[event] = settings.hooks[event].filter((g) => !isOurs(g));
    if (settings.hooks[event].length === 0) delete settings.hooks[event];
  }
  try {
    writeJson(CLAUDE_SETTINGS, settings);
  } catch (err) {
    dialog.showErrorBox('Clawd', `Could not write ${CLAUDE_SETTINGS}: ${err.message}`);
    return;
  }
  if (interactive) {
    dialog.showMessageBox({
      type: 'info',
      title: 'Clawd',
      message: 'Claude Code hooks removed.',
      detail: 'Claude Code will no longer report anything to the widget.',
    });
  }
}

// ---------------------------------------------------------------- window/tray

// Multi-size ICO: on Windows Electron loads the frame matching the size it is
// asked for (tray = small icon, window = large icon), so the pixel art stays
// crisp at every DPI instead of being resampled from one bitmap.
function iconImage() {
  return nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.ico'));
}

// The lamp sits in whichever corner of the window is nearest the screen's, and
// the tray opens away from that corner. What is remembered is the lamp, not
// the window: config.lamp is its centre on screen, config.corner is which
// quarter of its display it is in ('br', 'bl', 'tr', 'tl': the window's corner
// that holds it), and config.dock records which screen edges the window was
// left against, so it keeps hugging them when the work area changes (taskbar
// set to auto-hide, resized, moved...).
let corner = 'br';

// the lamp's centre, from the window's top-left
function lampOffset(c) {
  const s = winSize();
  const inset = Math.round(G.LAMP_INSET * scale());
  return { x: c[1] === 'l' ? inset : s - inset, y: c[0] === 't' ? inset : s - inset };
}

function windowAt(lamp, c) {
  const o = lampOffset(c);
  return { x: Math.round(lamp.x - o.x), y: Math.round(lamp.y - o.y) };
}

function lampAt(pos, c) {
  const o = lampOffset(c);
  return { x: pos.x + o.x, y: pos.y + o.y };
}

function workAreaAt(point) {
  return screen.getDisplayNearestPoint({ x: Math.round(point.x), y: Math.round(point.y) }).workArea;
}

// Which quarter of its display the lamp is in. A docked edge decides its own
// axis, so a window against the right edge always opens to the left.
function cornerFor(lamp, dock) {
  const a = workAreaAt(lamp);
  const d = dock || {};
  const v = Boolean(d.top) !== Boolean(d.bottom) ? (d.top ? 't' : 'b') : lamp.y < a.y + a.height / 2 ? 't' : 'b';
  const h = Boolean(d.left) !== Boolean(d.right) ? (d.left ? 'l' : 'r') : lamp.x < a.x + a.width / 2 ? 'l' : 'r';
  return v + h;
}

// keep the whole window inside a work area
function clampTo(a, p) {
  const s = winSize();
  return {
    x: Math.round(Math.min(Math.max(p.x, a.x), Math.max(a.x, a.x + a.width - s))),
    y: Math.round(Math.min(Math.max(p.y, a.y), Math.max(a.y, a.y + a.height - s))),
  };
}

// Which work-area edges a rectangle touches.
function dockOf(a, r, tol) {
  return {
    left: Math.abs(r.x - a.x) <= tol,
    right: Math.abs(r.x + r.width - (a.x + a.width)) <= tol,
    top: Math.abs(r.y - a.y) <= tol,
    bottom: Math.abs(r.y + r.height - (a.y + a.height)) <= tol,
  };
}

// Which edges the window is docked to. Only the two beside the lamp count:
// on a small display the window's far edge can reach the opposite side of
// the work area, and a dock recorded there would carry the lamp across the
// screen the next time the window is placed.
function dockFor(a, p, tol, c) {
  const s = winSize();
  return lampSide(dockOf(a, { x: p.x, y: p.y, width: s, height: s }, tol), c);
}

function lampSide(dock, c) {
  return {
    left: Boolean(dock.left) && c[1] === 'l',
    right: Boolean(dock.right) && c[1] === 'r',
    top: Boolean(dock.top) && c[0] === 't',
    bottom: Boolean(dock.bottom) && c[0] === 'b',
  };
}

// Snap the docked edges to the work area, then clamp.
function applyDock(a, p, dock) {
  const s = winSize();
  let { x, y } = p;
  if (dock) {
    if (dock.left) x = a.x;
    if (dock.right) x = a.x + a.width - s;
    if (dock.top) y = a.y;
    if (dock.bottom) y = a.y + a.height - s;
  }
  return clampTo(a, { x, y });
}

// Where the window goes for a lamp at this point.
function place(lamp, dock) {
  const a = workAreaAt(lamp);
  const c = cornerFor(lamp, dock);
  return { pos: applyDock(a, windowAt(lamp, c), dock), corner: c };
}

function defaultLamp() {
  const a = screen.getPrimaryDisplay().workArea;
  const s = winSize();
  config.dock = { left: false, right: true, top: false, bottom: true };
  return lampAt({ x: a.x + a.width - s, y: a.y + a.height - s }, 'br');
}

// Versions up to 1.3 stored config.x/y: the top-left of a 264 x 124 widget
// drawn at 70%. The lamp goes to the corner of that rectangle nearest the
// screen's, so the widget stays where it was put.
function migrateLamp() {
  const { x, y } = config;
  if (typeof x !== 'number' || typeof y !== 'number') return null;
  const k = 0.7 * scale();
  const old = { x, y, width: Math.round(264 * k), height: Math.round(124 * k) };
  const centre = { x: old.x + old.width / 2, y: old.y + old.height / 2 };
  // a position saved before docking existed: a widget left near an edge was
  // meant to sit on it (typically on top of a taskbar that has since been hidden)
  if (!config.dock) config.dock = dockOf(workAreaAt(centre), old, DOCK_MIGRATE_TOL);
  const c = cornerFor(centre, config.dock);
  config.dock = lampSide(config.dock, c);
  const s = winSize();
  const pos = { x: c[1] === 'l' ? old.x : old.x + old.width - s, y: c[0] === 't' ? old.y : old.y + old.height - s };
  delete config.x;
  delete config.y;
  return lampAt(pos, c);
}

function validPoint(p) {
  return Boolean(p && Number.isFinite(p.x) && Number.isFinite(p.y));
}

// The window's position from config; sets `corner` to match.
function restorePosition() {
  if (!validPoint(config.lamp)) {
    config.lamp = migrateLamp() || defaultLamp();
    saveConfig();
  }
  const p = place(config.lamp, config.dock);
  corner = p.corner;
  return p.pos;
}

let suppressMoveSave = false;

function moveWindow(pos) {
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  const s = winSize();
  if (pos.x === b.x && pos.y === b.y && b.width === s && b.height === s) return;
  suppressMoveSave = true;
  win.setBounds({ x: pos.x, y: pos.y, width: s, height: s });
  setTimeout(() => {
    suppressMoveSave = false;
  }, 250);
}

// Re-place the window from config (used when displays or work areas change).
// config.lamp is left as it is: a display that was unplugged may come back.
let placeTimer = null;
function replaceWindow() {
  clearTimeout(placeTimer);
  placeTimer = setTimeout(() => {
    if (!win || win.isDestroyed()) return;
    const was = corner;
    moveWindow(restorePosition());
    if (corner !== was) sendConfigToWidget();
  }, 150);
}

// The window has been dragged somewhere. Bring it back on screen if part of
// it was dragged off an edge, and if the lamp has crossed into another
// quarter of its display, turn the tray to open the other way from the same
// spot. Then remember where the lamp is.
function settleWindow() {
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  const a = workAreaAt(lampAt(b, corner));
  let pos = clampTo(a, b);
  let lamp = lampAt(pos, corner);
  const next = cornerFor(lamp, null);
  if (next !== corner) {
    corner = next;
    pos = clampTo(a, windowAt(lamp, corner));
    lamp = lampAt(pos, corner);
  }
  config.lamp = lamp;
  config.corner = corner;
  config.dock = dockFor(a, pos, DOCK_TOL, corner);
  saveConfig();
  moveWindow(pos);
  sendConfigToWidget();
}

function sendConfigToWidget() {
  if (win && !win.isDestroyed()) {
    win.webContents.send('config', {
      scale: scale(),
      dimIdle: !!config.dimIdle,
      clickThroughIdle: !!config.clickThroughIdle,
      corner,
    });
  }
}

// The size setting changed: the lamp stays where it is (docked edges stay
// docked) and the window is resized around it.
function applyWidgetSize() {
  if (!win || win.isDestroyed()) return;
  const p = place(config.lamp, config.dock);
  corner = p.corner;
  config.lamp = lampAt(p.pos, corner);
  config.corner = corner;
  saveConfig();
  moveWindow(p.pos);
}

function createWindow() {
  // Never-shown owner window: owned windows are excluded from Alt-Tab by
  // Windows itself, which holds even where the toolwindow style alone is
  // ignored (as on some Windows 11 builds).
  ownerWin = new BrowserWindow({
    show: false,
    width: 1,
    height: 1,
    frame: false,
    skipTaskbar: true,
    focusable: false,
  });
  const pos = restorePosition();
  win = new BrowserWindow({
    parent: ownerWin,
    width: winSize(),
    height: winSize(),
    x: pos.x,
    y: pos.y,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    hasShadow: false,
    skipTaskbar: true,
    type: 'toolbar', // WS_EX_TOOLWINDOW: hidden from the taskbar and Alt-Tab
    title: 'Clawd',
    icon: iconImage(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setMenuBarVisibility(false);
  win.setSkipTaskbar(true);
  win.on('show', () => win.setSkipTaskbar(true)); // skipTaskbar can reset on show
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.on('did-finish-load', () => {
    sendConfigToWidget();
    pushState();
    pushUsage();
  });
  let moveTimer = null;
  win.on('moved', () => {
    if (suppressMoveSave) return;
    clearTimeout(moveTimer);
    moveTimer = setTimeout(settleWindow, 300);
  });
  // The page's own right-click, and the system menu Windows would otherwise
  // show for a right-click on the parts the widget is dragged by.
  win.webContents.on('context-menu', () => {
    buildMenu().popup({ window: win });
  });
  win.on('system-context-menu', (event) => {
    event.preventDefault();
    buildMenu().popup({ window: win });
  });
  win.on('closed', () => {
    win = null;
  });
}

// ---------------------------------------------------------------- settings window

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    parent: ownerWin,
    width: 430,
    height: 760,
    // the page's own background (settings.css follows the system appearance),
    // so the window never flashes white before the page paints
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1b1c1f' : '#f2f2f7',
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    type: 'toolbar',
    alwaysOnTop: true,
    autoHideMenuBar: true,
    title: 'Clawd Settings',
    icon: iconImage(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  settingsWin.setMenuBarVisibility(false);
  settingsWin.setSkipTaskbar(true);
  settingsWin.loadFile(path.join(__dirname, 'renderer', 'settings.html'));
  settingsWin.on('closed', () => {
    settingsWin = null;
  });
}

function applySettings(next) {
  const prevPort = config.port;
  const prevPct = config.sizePct;
  config.port = clampInt(next.port, 1024, 65535, DEFAULTS.port);
  const prevStatusLine = config.statusLine;
  config.sizePct = clampInt(next.sizePct, SIZE_MIN, SIZE_MAX, DEFAULTS.sizePct);
  config.pruneHours = clampInt(next.pruneHours, 1, 168, DEFAULTS.pruneHours);
  config.statusLine = next.statusLine !== false;
  config.dimIdle = !!next.dimIdle;
  config.clickThroughIdle = !!next.clickThroughIdle;
  config.notify = !!next.notify;
  config.notifyAfterSec = clampInt(next.notifyAfterSec, 0, 3600, DEFAULTS.notifyAfterSec);
  config.notifySound = !!next.notifySound;
  saveConfig();
  const portChanged = config.port !== prevPort;
  if (portChanged) {
    restartServer();
    if (hooksInstalled()) installHooks(false); // hooks embed the port in their URL
  }
  // so does the status line command
  if (!config.statusLine && prevStatusLine) removeStatusLine();
  else if (config.statusLine && hooksInstalled() && (portChanged || !prevStatusLine)) installStatusLine();
  if (config.sizePct !== prevPct) applyWidgetSize();
  sendConfigToWidget();
  pushState();
}

// ---------------------------------------------------------------- focus terminal

// Best effort: find a window whose title mentions the session's project folder
// (Windows Terminal shows the active tab's title; VS Code titles include the
// workspace folder) and bring it to the foreground.
//
// The folder name reaches the script through an environment variable and is
// never written into its text: it comes from hook payloads, and PowerShell
// takes typographic quotes (’) as quotes too, so no escaping of it is safe.
const FOCUS_NAME_VAR = 'CLAWD_FOCUS_NAME';
const FOCUS_SCRIPT =
  `$n = $env:${FOCUS_NAME_VAR}\n` +
  `if (-not $n) { exit }\n` +
  `$n = $n.ToLower()\n` +
  `$p = Get-Process | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero -and $_.MainWindowTitle -and $_.MainWindowTitle.ToLower().Contains($n) } | Select-Object -First 1\n` +
  `if ($p) {\n` +
  `  Add-Type -Namespace SL -Name U32 -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c); [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr h, bool alt);'\n` +
  `  [SL.U32]::ShowWindow($p.MainWindowHandle, 9) | Out-Null\n` +
  `  [SL.U32]::SwitchToThisWindow($p.MainWindowHandle, $true)\n` +
  `}\n`;
const FOCUS_SCRIPT_ENC = Buffer.from(FOCUS_SCRIPT, 'utf16le').toString('base64');

function focusSessionTerminal(id) {
  const s = sessions.get(id);
  const base = s && s.cwd ? path.basename(s.cwd) : '';
  if (!base) return;
  try {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', FOCUS_SCRIPT_ENC],
      {
        windowsHide: true,
        stdio: 'ignore',
        env: Object.assign({}, process.env, { [FOCUS_NAME_VAR]: base }),
      }
    );
    child.on('error', () => {});
  } catch {}
}

// ---------------------------------------------------------------- notifications

// A Windows notification when a session has been waiting on the user for
// notifyAfterSec, for when the widget is out of sight (on another screen, or
// under a fullscreen app). One per wait, withdrawn as soon as the wait ends;
// clicking it brings that session's terminal forward.
const toasts = new Map(); // session id -> { since, toast } for the wait it was shown for
let toastTimer = null;

function updateToasts() {
  clearTimeout(toastTimer);
  toastTimer = null;
  const enabled = Boolean(config.notify) && Notification.isSupported();
  for (const [id, t] of toasts) {
    const s = sessions.get(id);
    if (enabled && s && s.state === 'permission' && s.since === t.since) continue;
    toasts.delete(id);
    try {
      t.toast.close();
    } catch {}
  }
  if (!enabled) return;
  const now = Date.now();
  let next = Infinity;
  for (const [id, s] of sessions) {
    if (s.state !== 'permission' || toasts.has(id)) continue;
    const due = s.since + config.notifyAfterSec * 1000;
    if (due <= now) showToast(id, s);
    else next = Math.min(next, due);
  }
  if (next !== Infinity) toastTimer = setTimeout(updateToasts, next - now + 50);
}

function showToast(id, s) {
  const label = sessionLabels().get(id) || 'Claude';
  const question = s.waitKind === 'question';
  const toast = new Notification({
    title: question ? `${label} has a question` : `${label} needs you`,
    body: s.detail || (question ? 'Claude is waiting for your answer.' : 'Claude is waiting for your permission.'),
    icon: iconImage(),
    silent: !config.notifySound,
  });
  toast.on('click', () => focusSessionTerminal(id));
  toast.on('failed', (_e, err) => livenessLog(`notification failed: ${err}`));
  // kept until the wait ends, so the click handler outlives the popup
  toasts.set(id, { since: s.since, toast });
  toast.show();
}

// ---------------------------------------------------------------- plan usage

// The figures and the bookkeeping of when the endpoint may be asked again;
// lib/usage.js explains the two sources and makes every decision.
let usageState = usageLib.createState();
let usageBusy = false;
let usageSaveTimer = null;

function loadUsage() {
  usageState = usageLib.restore(readJson(USAGE_PATH), Date.now());
}

function saveUsage() {
  clearTimeout(usageSaveTimer);
  usageSaveTimer = setTimeout(() => {
    try {
      writeJson(USAGE_PATH, usageLib.serialize(usageState));
    } catch {}
  }, 500);
}

function pushUsage() {
  if (win && !win.isDestroyed()) win.webContents.send('usage', usageLib.snapshot(usageState, Date.now()));
}

// Claude Code's status line has run: the session data it was handed, with the
// 5-hour and weekly figures in it once the API has reported them.
function handleStatusLine(payload) {
  if (typeof payload.clawd_selftest === 'string') {
    const seen = wrapperTrials.get(payload.clawd_selftest);
    if (seen) seen();
    return;
  }
  // an idle session's status line still carries the figures of its last
  // reply, however long ago that was (see applyStatusLine)
  const now = Date.now();
  const s = typeof payload.session_id === 'string' ? sessions.get(payload.session_id) : null;
  const fresh = !s || s.state !== 'ready' || now - s.lastEvent <= STATUS_FRESH_MS;
  const readings = usageLib.fromStatusLine(payload, now);
  if (usageLib.applyStatusLine(usageState, readings, { now, fresh, activeAt: s ? s.lastEvent : now })) {
    saveUsage();
    pushUsage();
  }
}

// Ask the endpoint, if lib/usage.js agrees that now is a time to. A failure
// is not shown: the last figures stay up, and the widget marks them once they
// are old. It goes in the log instead.
function refreshUsage(reason) {
  if (usageBusy) return;
  const now = Date.now();
  const cred = usageLib.credentials(readJson(CLAUDE_CREDENTIALS), now);
  const decision = usageLib.decide(usageState, {
    now,
    reason,
    token: cred.token,
    expired: cred.expired,
    active: sessions.size > 0,
  });
  if (!decision.fetch) return;
  usageBusy = true;
  usageLib.onAttempt(usageState, now);
  const failed = (what, failure) => {
    const wait = usageLib.onFailure(usageState, Date.now(), failure);
    livenessLog(`usage: ${what}; next try in ${Math.round(wait / 60000)} min`);
  };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), USAGE_TIMEOUT_MS);
  fetch(USAGE_URL, {
    signal: ctl.signal,
    headers: {
      Authorization: `Bearer ${cred.token}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'User-Agent': `claude-stoplight/${app.getVersion()}`,
    },
  })
    .then(async (res) => {
      if (!res.ok) {
        failed(`the endpoint answered ${res.status}`, {
          status: res.status,
          retryAfter: usageLib.retryAfterMs(res.headers.get('retry-after'), Date.now()),
        });
        return;
      }
      const readings = usageLib.fromApi(await res.json(), Date.now());
      if (readings.length) usageLib.onSuccess(usageState, Date.now(), readings);
      else failed('the endpoint reported no limits', { status: res.status });
    })
    .catch((err) => {
      failed(err && err.name === 'AbortError' ? 'the request timed out' : `the request failed (${(err && err.message) || err})`, {});
    })
    .finally(() => {
      clearTimeout(timer);
      usageBusy = false;
      saveUsage();
      pushUsage();
    });
}

// ---------------------------------------------------------------- status line

// Claude Code's status line is where the 5-hour and weekly figures come from
// (lib/statusline.js). With no status line of the user's own, ours is a bare
// curl call. With one, theirs is kept behind a wrapper, and the wrapper is
// tried here, on a stand-in for Claude Code's data, before settings.json is
// pointed at it: if it does not run cleanly, print something and reach us,
// their status line is left exactly as it was.
const wrapperTrials = new Map(); // nonce -> called when the wrapper's forward arrives
let statusLineBusy = false;
let statusLineSettled = Promise.resolve(); // the install in flight, for a scripted run to wait on

function savedStatusLine() {
  return statusline.isCommand(config.statusLineOriginal) ? config.statusLineOriginal : null;
}

function writeWrapperFiles(original) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  for (const file of statusline.wrapperFiles(original, config.port)) {
    fs.writeFileSync(path.join(DATA_DIR, file.name), statusline.encode(file));
  }
  // the shell it found last time may not be the one it runs under now
  try {
    fs.unlinkSync(path.join(DATA_DIR, statusline.FILES.shell));
  } catch {}
}

function removeWrapperFiles() {
  for (const name of Object.values(statusline.FILES)) {
    try {
      fs.unlinkSync(path.join(DATA_DIR, name));
    } catch {}
  }
}

function tryWrapper() {
  return new Promise((resolve) => {
    const nonce = crypto.randomBytes(8).toString('hex');
    let heard = false;
    let printed = 0;
    let done = false;
    let timer = null;
    let child = null;
    const finish = (ok, why) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      wrapperTrials.delete(nonce);
      livenessLog(ok ? 'status line: the wrapper works' : `status line: the wrapper was not used (${why})`);
      resolve(ok);
    };
    wrapperTrials.set(nonce, () => {
      heard = true;
    });
    try {
      child = spawn(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(DATA_DIR, statusline.FILES.wrapper)],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], cwd: os.homedir() }
      );
    } catch (err) {
      finish(false, err.message);
      return;
    }
    timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      finish(false, 'it did not finish in 20 s');
    }, 20000);
    child.stdout.on('data', (chunk) => {
      printed += chunk.length;
    });
    child.stdin.on('error', () => {});
    child.on('error', (err) => finish(false, err.message));
    child.on('close', (code) => {
      if (code !== 0) {
        finish(false, `exit code ${code}`);
        return;
      }
      // a status line that shows nothing through the wrapper is not one to risk
      if (!printed) {
        finish(false, 'the status line printed nothing through it');
        return;
      }
      // the wrapper does not wait for its forward: give that a moment to land
      const until = Date.now() + 3000;
      const check = () => {
        if (heard) finish(true);
        else if (Date.now() > until) finish(false, 'its forward never arrived');
        else setTimeout(check, 100);
      };
      check();
    });
    child.stdin.end(JSON.stringify(statusline.samplePayload(nonce, os.homedir())));
  });
}

function statusLineInstalled() {
  const settings = readJson(CLAUDE_SETTINGS);
  return Boolean(settings && statusline.isOurs(settings.statusLine));
}

// Make settings.json's statusLine ours, if it is not already. Quiet: there is
// nothing here the user needs to answer.
async function installStatusLine() {
  // the commands are Windows ones, and so is everything they are run through
  if (statusLineBusy || process.platform !== 'win32') return;
  statusLineBusy = true;
  try {
    const read = () => (fs.existsSync(CLAUDE_SETTINGS) ? readJson(CLAUDE_SETTINGS) : {});
    const ctx = () => ({ port: config.port, dir: DATA_DIR, saved: savedStatusLine() });
    const settings = read();
    if (settings === null) return; // unparseable: installHooks has already said so
    const plan = statusline.plan(settings, ctx());
    if (plan.kind === 'skip') return;
    if (plan.kind === 'wrap') {
      // ours already, but what it wraps is not on record: nothing to rebuild it from
      if (!plan.original) return;
      writeWrapperFiles(plan.original);
      if (plan.current) return;
      if (!(await tryWrapper())) {
        removeWrapperFiles();
        config.statusLineState = 'kept';
        saveConfig();
        return;
      }
      // turned off while the wrapper was being tried
      if (!config.statusLine) {
        removeWrapperFiles();
        return;
      }
    } else if (plan.current) {
      return;
    }
    // settings.json may have been rewritten while the wrapper was being tried
    const fresh = read();
    if (fresh === null) return;
    const again = statusline.plan(fresh, ctx());
    if (again.kind !== plan.kind || JSON.stringify(again.original) !== JSON.stringify(plan.original)) return;
    if (fs.existsSync(CLAUDE_SETTINGS)) backupClaudeSettings();
    if (plan.kind === 'wrap') config.statusLineOriginal = plan.original;
    else delete config.statusLineOriginal;
    config.statusLineState = plan.kind;
    saveConfig();
    fresh.statusLine = again.statusLine;
    writeJson(CLAUDE_SETTINGS, fresh);
    livenessLog(`status line: installed (${plan.kind})`);
  } catch (err) {
    livenessLog(`status line: install failed (${err && err.message})`);
  } finally {
    statusLineBusy = false;
    // asked to remove it while this was under way
    if (!config.statusLine && statusLineInstalled()) removeStatusLine();
  }
}

// Take ours out again, putting back the status line it wrapped. The saved
// original and the wrapper's files are the only way back to the user's own
// status line, so they are let go of only once settings.json no longer points
// at the wrapper. If it cannot be read or written now, everything stays as it
// is and the next launch tries again. Returns true when ours is out.
function removeStatusLine() {
  // an install in flight finishes first, then takes itself out (see its end)
  if (statusLineBusy) return false;
  try {
    const settings = fs.existsSync(CLAUDE_SETTINGS) ? readJson(CLAUDE_SETTINGS) : {};
    if (settings === null) {
      livenessLog('status line: not removed, settings.json could not be read');
      return false;
    }
    if (statusline.remove(settings, savedStatusLine())) {
      backupClaudeSettings();
      writeJson(CLAUDE_SETTINGS, settings);
      livenessLog('status line: removed');
    }
  } catch (err) {
    livenessLog(`status line: removal failed (${err && err.message})`);
    return false;
  }
  delete config.statusLineOriginal;
  config.statusLineState = 'off';
  saveConfig();
  removeWrapperFiles();
  return true;
}

// ---------------------------------------------------------------- hover watch

// Hover is decided here, geometrically, by polling the cursor against the
// widget's shape. Renderer mouseenter/mouseleave can't be trusted: with
// software rendering Windows hit-tests the transparent window per-pixel, so
// parts of the window never see the mouse at all.
let hovered = false;
let hoverSince = 0;
// which part of the window is the widget right now, from the page: the opened
// tray, or the lamp and however far the wait pill reaches beside it
let live = { open: false, reach: 0 };
let hoverPaused = false; // a scripted run drives the page's hover itself

// The tray has been open long enough to read: every finished turn it showed
// for at least SEEN_MS counts as seen.
function markSeen(from, to) {
  let changed = false;
  for (const s of sessions.values()) {
    if (s.unreadAt && s.state === 'ready' && Math.max(from, s.unreadAt) <= to - SEEN_MS) {
      s.unreadAt = null;
      changed = true;
    }
  }
  if (changed) {
    persistSessions();
    pushState();
  }
}

function pollHover() {
  if (!win || win.isDestroyed() || hoverPaused) return;
  const p = screen.getCursorScreenPoint();
  const lamp = lampAt(win.getBounds(), corner);
  // how far the cursor is from the lamp's centre, measured into the fan, in
  // the units geometry.js draws in
  const k = scale();
  const u = (corner[1] === 'l' ? p.x - lamp.x : lamp.x - p.x) / k;
  const v = (corner[0] === 't' ? p.y - lamp.y : lamp.y - p.y) / k;
  const pad = 3;
  const inside = live.open ? G.insideTray(u, v, pad) : G.insideRest(u, v, live.reach, pad);
  if (inside !== hovered) {
    hovered = inside;
    if (hovered) hoverSince = Date.now();
    else markSeen(hoverSince, Date.now());
    win.webContents.send('hover', hovered);
    // the tray is about to show the usage figures: worth a look at their age
    if (hovered) refreshUsage('hover');
  }
}

// ---------------------------------------------------------------- auto-update

let updater = null;
let manualCheck = false;

function initAutoUpdate() {
  if (!app.isPackaged) return;
  try {
    updater = require('electron-updater').autoUpdater;
  } catch {
    return;
  }
  updater.autoDownload = true;
  updater.on('error', (err) => {
    if (manualCheck) {
      manualCheck = false;
      dialog.showMessageBox({
        type: 'error',
        title: 'Clawd',
        message: 'Update check failed.',
        detail: String((err && err.message) || err),
      });
    }
  });
  updater.on('update-not-available', () => {
    if (manualCheck) {
      manualCheck = false;
      dialog.showMessageBox({
        type: 'info',
        title: 'Clawd',
        message: `You're up to date (v${app.getVersion()}).`,
      });
    }
  });
  updater.on('update-available', (info) => {
    if (manualCheck) {
      manualCheck = false;
      dialog.showMessageBox({
        type: 'info',
        title: 'Clawd',
        message: `Version ${info.version} is downloading.`,
        detail: 'You will be asked to restart when it is ready.',
      });
    }
  });
  updater.on('update-downloaded', (info) => {
    dialog
      .showMessageBox({
        type: 'question',
        title: 'Clawd',
        message: `Version ${info.version} is ready to install.`,
        buttons: ['Restart now', 'Later'],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response === 0) updater.quitAndInstall();
      });
  });
  // one check at startup; after that only via the tray menu
  updater.checkForUpdates().catch(() => {});
}

function checkForUpdatesManually() {
  if (!updater) {
    dialog.showMessageBox({
      type: 'info',
      title: 'Clawd',
      message: 'Updates are only available in the installed app.',
    });
    return;
  }
  manualCheck = true;
  updater.checkForUpdates().catch(() => {});
}

// ---------------------------------------------------------------- autostart/menu

// In dev the registered command must be "electron.exe <app dir>", not bare electron.exe.
function loginItemOptions() {
  return app.isPackaged ? {} : { path: process.execPath, args: [app.getAppPath()] };
}

function autostartEnabled() {
  return app.getLoginItemSettings(loginItemOptions()).openAtLogin;
}

function setAutostart(enabled) {
  app.setLoginItemSettings(Object.assign({ openAtLogin: enabled }, loginItemOptions()));
}

function buildMenu() {
  const installed = hooksInstalled();
  return Menu.buildFromTemplate([
    { label: `Clawd v${app.getVersion()}`, enabled: false },
    { type: 'separator' },
    { label: 'Settings…', click: openSettings },
    {
      label: 'Reset sessions (clear the lamp)',
      click: () => {
        sessions.clear();
        persistSessions();
        pushState();
      },
    },
    { type: 'separator' },
    {
      label: 'Start with Windows',
      type: 'checkbox',
      checked: autostartEnabled(),
      click: (item) => setAutostart(item.checked),
    },
    {
      // the status line goes with them: it is one more thing Claude Code runs for us
      label: installed ? 'Remove Claude Code hooks' : 'Install Claude Code hooks',
      click: () => {
        if (installed) {
          // the status line is put back to how it was first; with the hooks
          // gone, nothing would take it out later
          if (statusLineInstalled() && !removeStatusLine()) {
            dialog.showErrorBox(
              'Clawd',
              `The status line command could not be removed from ${CLAUDE_SETTINGS}, so the hooks were left in place too. ` +
                'Check that the file is valid JSON and try again.'
            );
            return;
          }
          removeHooks(true);
        } else if (installHooks(true) && config.statusLine) {
          installStatusLine();
        }
      },
    },
    {
      label: 'Open Claude settings folder',
      click: () => shell.showItemInFolder(CLAUDE_SETTINGS),
    },
    { type: 'separator' },
    { label: 'Check for updates…', click: checkForUpdatesManually },
    { label: 'Quit', click: () => app.quit() },
  ]);
}

function createTray() {
  tray = new Tray(iconImage());
  tray.setToolTip('Clawd');
  tray.on('click', () => {
    if (win) {
      win.show();
      win.focus();
    }
  });
  tray.on('right-click', () => tray.popUpContextMenu(buildMenu()));
}

// ---------------------------------------------------------------- ipc

ipcMain.on('widget:live', (_e, region) => {
  live = {
    open: Boolean(region && region.open),
    reach: clampInt(region && region.reach, 0, G.SIZE, 0),
  };
});
ipcMain.on('widget:focus-session', (_e, id) => {
  const s = sessions.get(String(id || ''));
  if (s && s.unreadAt) {
    s.unreadAt = null;
    persistSessions();
    pushState();
  }
  focusSessionTerminal(String(id || ''));
});
ipcMain.handle('settings:get', () => ({
  port: config.port,
  sizePct: config.sizePct,
  pruneHours: config.pruneHours,
  dimIdle: !!config.dimIdle,
  clickThroughIdle: !!config.clickThroughIdle,
  notify: !!config.notify,
  notifyAfterSec: config.notifyAfterSec,
  notifySound: !!config.notifySound,
  statusLine: !!config.statusLine,
  // how the status line stands: 'plain' or 'wrap' when ours is in place,
  // 'kept' when the user's own was left alone, otherwise not installed
  statusLineState: statusLineInstalled() ? config.statusLineState || 'plain' : config.statusLineState === 'kept' ? 'kept' : 'off',
  sizeMin: SIZE_MIN,
  sizeMax: SIZE_MAX,
  version: app.getVersion(),
}));
ipcMain.on('settings:save', (_e, s) => applySettings(s || {}));

// ---------------------------------------------------------------- scripted run

function runSmoke() {
  require('./lib/smoke')({
    dir: SMOKE,
    win,
    port: config.port,
    // the page's hover, driven by the script instead of the cursor
    setHover(on) {
      hoverPaused = true;
      hovered = Boolean(on);
      win.webContents.send('hover', hovered);
    },
    // as if the window had been dragged there and let go
    moveTo(pos) {
      suppressMoveSave = true;
      win.setBounds({ x: pos.x, y: pos.y, width: winSize(), height: winSize() });
      suppressMoveSave = false;
      settleWindow();
    },
    workArea: () => screen.getPrimaryDisplay().workArea,
    state: () => ({
      corner,
      live,
      lamp: config.lamp,
      dock: config.dock,
      bounds: win.getBounds(),
      winSize: winSize(),
      usage: usageLib.snapshot(usageState, Date.now()),
    }),
    settled: () => statusLineSettled,
    extra: () => ({
      platform: process.platform,
      hooksInstalled: hooksInstalled(),
      statusLine: (readJson(CLAUDE_SETTINGS) || {}).statusLine || null,
      statusLineState: config.statusLineState || null,
    }),
    quit: (code) => app.exit(code),
  });
}

// ---------------------------------------------------------------- lifecycle

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      win.show();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    loadConfig();
    loadSessions();
    loadUsage();
    startServer();
    createWindow();
    createTray();
    setInterval(pruneSessions, 60 * 1000);
    setInterval(syncSessions, LIVENESS_MS);
    syncSessions(); // pick up sessions already running, drop ones that died while we were away
    watchSessionsDir();
    setInterval(() => refreshUsage('timer'), USAGE_TIMER_MS);
    refreshUsage('startup');
    setInterval(pollHover, 120);
    // a docked widget follows its screen edge when the work area changes
    // (taskbar hidden/shown/resized, display added/removed, DPI change)
    screen.on('display-metrics-changed', replaceWindow);
    screen.on('display-added', replaceWindow);
    screen.on('display-removed', replaceWindow);
    if (!SMOKE) initAutoUpdate();

    // First-run setup: install hooks once; enable autostart on the first packaged
    // run (tracked separately so a prior dev run doesn't skip it). Both stay
    // user-toggleable from the tray afterwards.
    if (!config.setupDone) {
      installHooks(false);
      config.setupDone = true;
      saveConfig();
    } else if (hooksInstalled() && !hooksComplete()) {
      installHooks(false); // an update added hook events; keep the install current
    }
    // the status line goes wherever the hooks are, unless it has been turned
    // off (and if taking it out failed last time, this is the next try)
    if (config.statusLine && hooksInstalled()) statusLineSettled = installStatusLine();
    else if (!config.statusLine && statusLineInstalled()) removeStatusLine();
    if (app.isPackaged && !config.autostartDone && !SMOKE) {
      setAutostart(true);
      config.autostartDone = true;
      saveConfig();
    }
    if (SMOKE) runSmoke();
  });

  app.on('window-all-closed', () => app.quit());
}
