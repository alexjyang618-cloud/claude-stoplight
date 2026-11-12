const { app, BrowserWindow, Tray, Menu, Notification, nativeImage, nativeTheme, screen, dialog, shell, ipcMain } = require('electron');
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Software rendering: drops the GPU process / shared textures, a big chunk of
// the app's memory footprint. Plenty for a tiny widget with CSS animations.
app.disableHardwareAcceleration();

// Windows shows a toast only for an app id it knows: the installer gives the
// Start Menu shortcut this one (build.appId in package.json).
const APP_ID = 'com.alexyang.claude-stoplight';
if (process.platform === 'win32') app.setAppUserModelId(app.isPackaged ? APP_ID : process.execPath);

const DATA_DIR = path.join(os.homedir(), '.claude-stoplight');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const STATE_PATH = path.join(DATA_DIR, 'state.json');
const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const CLAUDE_SETTINGS = path.join(CLAUDE_DIR, 'settings.json');

const MARKER = 'claude-stoplight/event'; // identifies our hook entries inside settings.json
const BASE_W = 264; // widget design size in CSS px, before zoom
const BASE_H = 124;
const BASE_ZOOM = 0.7;
// The window is permanently tall enough for the session panel (which fades in
// above the widget), so it never has to resize — resizes can't animate
// smoothly on Windows. The extra space is fully transparent, and transparent
// pixels pass mouse events through, so it obstructs nothing.
const PANEL_MAX = 426; // panel max-height + margin, in CSS px before zoom

const DEFAULTS = {
  port: 47615,
  sizePct: 100, // widget scale, 50–200 (%)
  pruneHours: 6, // drop sessions silent this long (terminal killed without SessionEnd)
  dimIdle: false, // fade the widget when green / no sessions
  clickThroughIdle: false, // let clicks pass through the widget when green / no sessions
  notify: true, // a Windows notification when a session has waited on the user notifyAfterSec
  notifyAfterSec: 30,
  notifySound: false, // play the Windows notification sound with it
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

// Plan usage (the same numbers as Claude Code's /usage): read with the
// Claude Code OAuth token from ~/.claude/.credentials.json, which Claude Code
// itself keeps fresh. Polled slowly in the background and again on hover when
// the last reading is older than USAGE_HOVER_MAX_AGE_MS.
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CLAUDE_CREDENTIALS = path.join(CLAUDE_DIR, '.credentials.json');
const USAGE_POLL_MS = 3 * 60 * 1000;
const USAGE_HOVER_MAX_AGE_MS = 45 * 1000;
const USAGE_TIMEOUT_MS = 10 * 1000;
// After a failed request nothing is sent for a while, however often the timer
// fires or the widget is hovered: a minute at first, doubling each time the
// server refuses again (a 429 is the endpoint rate limiting us), and never
// less than the Retry-After it asks for.
const USAGE_BACKOFF_MS = 60 * 1000;
const USAGE_BACKOFF_MAX_MS = 30 * 60 * 1000;
const USAGE_RETRY_AFTER_MAX_MS = 60 * 60 * 1000;

// A turn that ran at least this long earns Clawd a celebratory hop when it ends.
const LONG_TURN_MS = 60 * 1000;
// A finished turn stays marked until the session panel has been open this long.
const SEEN_MS = 800;
// Longest description of a tool call or background task kept for display.
const DETAIL_MAX = 120;
// Never let an escapade keep Clawd away from the widget longer than this.
const ESCAPADE_GUARD_MS = 45 * 1000;

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
//                 noPid (true: never trust the registry's pid for this id again) }
const sessions = new Map();
// session_id -> when syncSessions dropped it (guards against a wrong pid flapping)
const reaped = new Map();

// ---------------------------------------------------------------- config/state

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
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
  config.sizePct = clampInt(config.sizePct, 50, 200, DEFAULTS.sizePct);
  config.pruneHours = clampInt(config.pruneHours, 1, 168, DEFAULTS.pruneHours);
  config.notifyAfterSec = clampInt(config.notifyAfterSec, 0, 3600, DEFAULTS.notifyAfterSec);
}

function saveConfig() {
  try {
    writeJson(CONFIG_PATH, config);
  } catch {}
}

function zoomFactor() {
  return BASE_ZOOM * (config.sizePct / 100);
}

function winW() {
  return Math.round(BASE_W * zoomFactor());
}

function winH() {
  // height of the visible widget base area (bottom of the window)
  return Math.round(BASE_H * zoomFactor());
}

function fullH() {
  // actual window height, including the transparent panel space above
  return Math.round((BASE_H + PANEL_MAX) * zoomFactor());
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
    const match = /^\/claude-stoplight\/event\/([A-Za-z]+)$/.exec(req.url || '');
    if (!match || req.method !== 'POST') {
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
//    sitting idle, when the widget started), with the registry's idle/busy state;
//  - attach pids to sessions that still lack one;
//  - correct drift between working and ready when the registry's status is
//    newer than our last hook event (a Stop or prompt we missed);
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
    } else if (rec && rec.status && rec.statusAt && rec.statusAt > s.lastEvent + 1000) {
      if (rec.status === 'idle' && s.state === 'working') {
        Object.assign(s, {
          state: 'ready',
          since: rec.statusAt,
          tool: null,
          waitKind: null,
          turnStart: null,
          detail: null,
          unreadAt: rec.statusAt,
        });
        livenessLog(`drift ${String(id).slice(0, 8)} working -> ready (registry idle)`);
        changed = true;
      } else if (rec.status !== 'idle' && s.state === 'ready') {
        Object.assign(s, { state: 'working', since: rec.statusAt, turnStart: rec.statusAt, detail: null });
        livenessLog(`drift ${String(id).slice(0, 8)} ready -> working (registry ${rec.status})`);
        changed = true;
      }
    }
  }
  for (const rec of reg.byId.values()) {
    if (sessions.has(rec.id) || !alive(rec.pid, null, rec.pstart)) continue;
    if (reaped.has(rec.id) && now - reaped.get(rec.id) < REAP_GUARD_MS) continue;
    const idle = rec.status === 'idle';
    const since = rec.statusAt || rec.startedAt || now;
    sessions.set(rec.id, {
      state: idle ? 'ready' : 'working',
      since,
      lastEvent: now,
      cwd: rec.cwd,
      tool: null,
      waitKind: null,
      detail: null,
      bg: null,
      bgSince: null,
      unreadAt: null,
      turnStart: idle ? null : since,
      name: rec.name,
      nameSource: rec.nameSource,
      pid: rec.pid,
      pname: names.get(rec.pid) || null,
      pstart: rec.pstart,
      noPid: false,
    });
    livenessLog(`discover ${rec.id.slice(0, 8)} pid=${rec.pid} status=${rec.status || '?'}`);
    changed = true;
  }
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
    const backup = `${CLAUDE_SETTINGS}.backup-stoplight-${Date.now()}`;
    try {
      fs.copyFileSync(CLAUDE_SETTINGS, backup);
    } catch {}
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
        'Claude Code sessions will now report their status to the stoplight. ' +
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
      detail: 'Claude Code will no longer report anything to the stoplight.',
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

// Clamp the window so the visible widget (its bottom winH() slice) stays fully
// inside the nearest display's work area. The transparent panel space above may
// hang off the top of the screen — nothing visible lives there when collapsed.
function clampPos(x, y, w, h) {
  const baseH = winH();
  const a = screen.getDisplayMatching({ x, y: y + h - baseH, width: w, height: baseH }).workArea;
  return {
    x: Math.min(Math.max(x, a.x), a.x + a.width - w),
    y: Math.min(Math.max(y, a.y + baseH - h), a.y + a.height - h),
  };
}

// Work area of the display the visible widget base (bottom winH() slice of a
// window at x,y with size w,h) mostly lies on.
function workAreaFor(x, y, w, h) {
  const baseH = winH();
  return screen.getDisplayMatching({ x, y: y + h - baseH, width: w, height: baseH }).workArea;
}

// Which work-area edges the visible widget touches at this window position.
function dockFor(x, y, w, h, tol) {
  const a = workAreaFor(x, y, w, h);
  const baseTop = y + h - winH();
  return {
    left: Math.abs(x - a.x) <= tol,
    right: Math.abs(x + w - (a.x + a.width)) <= tol,
    top: Math.abs(baseTop - a.y) <= tol,
    bottom: Math.abs(y + h - (a.y + a.height)) <= tol,
  };
}

// Snap the docked edges to the current work area, then clamp.
function applyDock(x, y, w, h, dock) {
  if (dock) {
    const a = workAreaFor(x, y, w, h);
    if (dock.left) x = a.x;
    if (dock.right) x = a.x + a.width - w;
    if (dock.top) y = a.y + winH() - h;
    if (dock.bottom) y = a.y + a.height - h;
  }
  return clampPos(x, y, w, h);
}

function isDocked(dock) {
  return Boolean(dock && (dock.left || dock.right || dock.top || dock.bottom));
}

// config.x/y store the top-left of the visible widget base area (which is what
// pre-1.2.3 versions stored as the whole window position, so old configs load
// unchanged); the window top sits fullH()-winH() above it. config.dock records
// which screen edges the widget was left against, so it keeps hugging them
// when the work area changes (taskbar set to auto-hide, resized, moved...).
function restorePosition() {
  const { x, y } = config;
  if (typeof x !== 'number' || typeof y !== 'number') return defaultPosition();
  const w = winW();
  const h = fullH();
  const wy = y + winH() - h;
  if (!config.dock) {
    // a position saved before docking existed: a widget left near an edge was
    // meant to sit on it (typically on top of a taskbar that has since been hidden)
    config.dock = dockFor(x, wy, w, h, DOCK_MIGRATE_TOL);
    saveConfig();
  }
  return applyDock(x, wy, w, h, config.dock);
}

function defaultPosition() {
  const a = screen.getPrimaryDisplay().workArea;
  config.dock = { left: false, right: true, top: false, bottom: true };
  return { x: a.x + a.width - winW(), y: a.y + a.height - fullH() };
}

// Re-place the window from config (used when displays or work areas change).
let placeTimer = null;
function replaceWindow() {
  clearTimeout(placeTimer);
  placeTimer = setTimeout(() => {
    if (!win || win.isDestroyed()) return;
    const b = win.getBounds();
    const p = restorePosition();
    if (p.x === b.x && p.y === b.y) return;
    suppressMoveSave = true;
    win.setBounds({ x: p.x, y: p.y, width: b.width, height: b.height });
    setTimeout(() => {
      suppressMoveSave = false;
    }, 250);
  }, 150);
}

function sendConfigToWidget() {
  if (win && !win.isDestroyed()) {
    win.webContents.send('config', {
      zoom: zoomFactor(),
      dimIdle: !!config.dimIdle,
      clickThroughIdle: !!config.clickThroughIdle,
    });
  }
}

let suppressMoveSave = false;
// how much of the window (from the bottom) is currently "live" for hover:
// the base widget, plus the session panel while the renderer shows it
let hoverH = 0;

function applyWidgetSize() {
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  const w = winW();
  const h = fullH();
  // keep the bottom-right corner where the user put it (docked edges stay docked)
  const { x, y } = applyDock(b.x + b.width - w, b.y + b.height - h, w, h, config.dock);
  suppressMoveSave = true;
  win.setBounds({ x, y, width: w, height: h });
  setTimeout(() => {
    suppressMoveSave = false;
  }, 250);
  config.x = x;
  config.y = y + h - winH();
  saveConfig();
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
    width: winW(),
    height: fullH(),
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
    moveTimer = setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      const b = win.getBounds();
      // snap back on screen if part of the widget was dragged off an edge
      const c = clampPos(b.x, b.y, b.width, b.height);
      if (c.x !== b.x || c.y !== b.y) {
        suppressMoveSave = true;
        win.setBounds({ x: c.x, y: c.y, width: b.width, height: b.height });
        setTimeout(() => {
          suppressMoveSave = false;
        }, 250);
      }
      config.x = c.x;
      config.y = c.y + b.height - winH();
      config.dock = dockFor(c.x, c.y, b.width, b.height, DOCK_TOL);
      saveConfig();
    }, 300);
  });
  win.webContents.on('context-menu', () => {
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
    height: 684,
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
  config.sizePct = clampInt(next.sizePct, 50, 200, DEFAULTS.sizePct);
  config.pruneHours = clampInt(next.pruneHours, 1, 168, DEFAULTS.pruneHours);
  config.dimIdle = !!next.dimIdle;
  config.clickThroughIdle = !!next.clickThroughIdle;
  config.notify = !!next.notify;
  config.notifyAfterSec = clampInt(next.notifyAfterSec, 0, 3600, DEFAULTS.notifyAfterSec);
  config.notifySound = !!next.notifySound;
  saveConfig();
  if (config.port !== prevPort) {
    restartServer();
    if (hooksInstalled()) installHooks(false); // hooks embed the port in their URL
  }
  if (config.sizePct !== prevPct) applyWidgetSize();
  sendConfigToWidget();
  pushState();
}

// ---------------------------------------------------------------- focus terminal

// Best effort: find a window whose title mentions the session's project folder
// (Windows Terminal shows the active tab's title; VS Code titles include the
// workspace folder), bring it to the foreground, and report where it is so
// Clawd can run over and knock.
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
  `  Add-Type -Namespace SL -Name U32 -MemberDefinition '[StructLayout(LayoutKind.Sequential)] public struct RECT { public int L; public int T; public int R; public int B; } [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c); [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr h, bool alt); [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);'\n` +
  `  [SL.U32]::ShowWindow($p.MainWindowHandle, 9) | Out-Null\n` +
  `  [SL.U32]::SwitchToThisWindow($p.MainWindowHandle, $true)\n` +
  `  $r = New-Object SL.U32+RECT\n` +
  `  if ([SL.U32]::GetWindowRect($p.MainWindowHandle, [ref]$r)) { Write-Output "RECT $($r.L),$($r.T),$($r.R),$($r.B)" }\n` +
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
        stdio: ['ignore', 'pipe', 'ignore'],
        env: Object.assign({}, process.env, { [FOCUS_NAME_VAR]: base }),
      }
    );
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.on('close', () => {
      const m = /RECT (-?\d+),(-?\d+),(-?\d+),(-?\d+)/.exec(out);
      if (m) beginVisit({ left: +m[1], top: +m[2], right: +m[3], bottom: +m[4] });
    });
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

// { bars: [{ key, label, percent, resetsAt, severity }], fetchedAt, error }
let usage = { bars: [], fetchedAt: 0, error: null };
let usageBusy = false;
let usageFails = 0; // failed requests in a row
let usageRetryAt = 0; // no request is sent before this
let usageToken = null; // the sign-in token the last request used

// Retry-After is a number of seconds or an HTTP date.
function retryAfterMs(value, now) {
  if (!value) return 0;
  const secs = Number(value);
  const ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(value) - now;
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, USAGE_RETRY_AFTER_MAX_MS) : 0;
}

// How long to stay quiet after the nth failure in a row. Only a refusal from
// the server lengthens the wait: a dropped connection or a timeout says
// nothing about the next attempt, and the figures should come back promptly
// once the network does.
function usageBackoffMs(fails, refused, retryAfter) {
  const wait = refused ? Math.min(USAGE_BACKOFF_MAX_MS, USAGE_BACKOFF_MS * 2 ** (fails - 1)) : USAGE_BACKOFF_MS;
  return Math.max(wait, retryAfter || 0);
}

function readAccessToken() {
  const j = readJson(CLAUDE_CREDENTIALS);
  const o = j && j.claudeAiOauth;
  return o && typeof o.accessToken === 'string' && o.accessToken ? o.accessToken : null;
}

function pct(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : null;
}

// The three bars: the 5-hour session window, the weekly all-models window, and
// the weekly window scoped to the top model (named by the API, e.g. "Fable").
function usageBars(d) {
  const limits = Array.isArray(d.limits) ? d.limits : [];
  const bar = (key, label, l, fallback) => {
    const percent = l ? pct(l.percent) : fallback ? pct(fallback.utilization) : null;
    if (percent === null) return null;
    const resetsAt = Date.parse((l && l.resets_at) || (fallback && fallback.resets_at) || '') || null;
    return { key, label, percent, resetsAt, severity: (l && l.severity) || null };
  };
  const scoped = limits.find((l) => l.kind === 'weekly_scoped' && l.scope && l.scope.model);
  const scopedName = (scoped && scoped.scope.model.display_name) || 'Fable';
  return [
    bar('session', '5-hour', limits.find((l) => l.kind === 'session'), d.five_hour),
    bar('weekly', 'Weekly', limits.find((l) => l.kind === 'weekly_all'), d.seven_day),
    bar('model', scopedName, scoped, d.seven_day_opus),
  ].filter(Boolean);
}

function pushUsage() {
  if (win && !win.isDestroyed()) win.webContents.send('usage', usage);
}

function pollUsage() {
  if (usageBusy) return;
  const token = readAccessToken();
  if (!token) {
    usage = Object.assign({}, usage, { error: 'not signed in to Claude Code' });
    pushUsage();
    return;
  }
  // a new sign-in is worth trying at once
  if (token !== usageToken) {
    usageToken = token;
    usageFails = 0;
    usageRetryAt = 0;
  }
  if (Date.now() < usageRetryAt) return;
  usageBusy = true;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), USAGE_TIMEOUT_MS);
  fetch(USAGE_URL, {
    signal: ctl.signal,
    headers: {
      Authorization: `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'User-Agent': `claude-stoplight/${app.getVersion()}`,
    },
  })
    .then(async (res) => {
      if (!res.ok) {
        const err = new Error(
          res.status === 401 || res.status === 403
            ? 'Claude Code sign-in expired'
            : res.status === 429
              ? 'usage is rate limited'
              : `usage request failed (${res.status})`
        );
        err.refused = true;
        err.retryAfter = retryAfterMs(res.headers.get('retry-after'), Date.now());
        throw err;
      }
      const bars = usageBars(await res.json());
      if (!bars.length) throw new Error('no usage limits reported');
      usage = { bars, fetchedAt: Date.now(), error: null };
      usageFails = 0;
      usageRetryAt = 0;
    })
    .catch((err) => {
      const msg = err && err.name === 'AbortError' ? 'usage request timed out' : (err && err.message) || 'usage unavailable';
      usage = Object.assign({}, usage, { error: msg });
      usageFails += 1;
      usageRetryAt = Date.now() + usageBackoffMs(usageFails, Boolean(err && err.refused), err && err.retryAfter);
    })
    .finally(() => {
      clearTimeout(timer);
      usageBusy = false;
      pushUsage();
    });
}

// ---------------------------------------------------------------- hover watch

// Hover is decided here, geometrically, by polling the cursor against the
// window bounds. Renderer mouseenter/mouseleave can't be trusted: with
// software rendering Windows hit-tests the transparent window per-pixel, so
// parts of the window never see the mouse at all.
let hovered = false;
let hoverSince = 0;

// The panel has been open long enough to read: every finished turn it showed
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
  if (!win || win.isDestroyed()) return;
  const p = screen.getCursorScreenPoint();
  const b = win.getBounds();
  // only the live bottom slice counts: base widget + open session panel
  const effH = Math.max(winH(), Math.min(hoverH || 0, b.height));
  const top = b.y + b.height - effH;
  const pad = 3;
  const inside =
    p.x >= b.x - pad &&
    p.x <= b.x + b.width + pad &&
    p.y >= top - pad &&
    p.y <= b.y + b.height + pad;
  if (inside !== hovered) {
    hovered = inside;
    if (hovered) hoverSince = Date.now();
    else markSeen(hoverSince, Date.now());
    win.webContents.send('hover', hovered);
    // the panel is about to show the usage bars: make sure they are fresh
    if (hovered && Date.now() - usage.fetchedAt > USAGE_HOVER_MAX_AGE_MS) pollUsage();
  }
}

// ---------------------------------------------------------------- clawd escapade

// When the user grabs Clawd off the widget, he is re-rendered in a hidden,
// full-display overlay window so he can swing at the cursor, fall to the
// bottom of the desktop, and walk home. The widget window keeps pointer
// capture for that first drag. The overlay is click-through except while the
// cursor is over Clawd (the overlay tells us, see 'clawd:catchable'), so he
// can be caught again mid-fall or mid-walk. The overlay is created at startup
// and kept (hidden) for the life of the app: a cold load takes about a second,
// and a quick fling used to release Clawd before the overlay had even loaded,
// which lost the release and left him glued to the cursor. A "visit" is the
// same machinery in reverse: Clawd hops down, runs to a session's terminal
// window, and comes back.

let overlayWin = null;
let cursorTimer = null;
let escapadeGuard = null;
let escapade = false;
let overlayBegun = false; // the overlay has been told about the current escapade
let releasePending = false; // the button came up before the overlay was ready
let lastClawdRect = null; // where the widget last drew Clawd, for visits

function ensureOverlay() {
  if (overlayWin && !overlayWin.isDestroyed()) return overlayWin;
  overlayWin = new BrowserWindow({
    parent: ownerWin,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    hasShadow: false,
    skipTaskbar: true,
    type: 'toolbar',
    title: 'Clawd Overlay',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  overlayWin.setIgnoreMouseEvents(true);
  overlayWin.setMenuBarVisibility(false);
  overlayWin.loadFile(path.join(__dirname, 'renderer', 'overlay.html'));
  const ov = overlayWin;
  // a dead overlay page would strand Clawd: end the escapade and rebuild it
  ov.webContents.on('render-process-gone', () => {
    if (escapade) endEscapade();
    if (!ov.isDestroyed()) ov.destroy();
    setTimeout(ensureOverlay, 1000);
  });
  ov.on('closed', () => {
    if (overlayWin === ov) overlayWin = null;
  });
  return overlayWin;
}

function validRect(rect) {
  return Boolean(
    rect && typeof rect.x === 'number' && typeof rect.width === 'number' && rect.width > 0
  );
}

// rect: Clawd's box in the widget (CSS px); visit: { x } screen coordinate to run to, or null
function startEscapade(rect, visit) {
  if (escapade || !win || win.isDestroyed() || !validRect(rect)) return;
  escapade = true;
  overlayBegun = false;
  releasePending = false;
  const ov = ensureOverlay();
  const wb = win.getBounds();
  const disp = screen.getDisplayMatching(wb);
  const params = {
    state: aggregate(),
    origin: { x: disp.bounds.x, y: disp.bounds.y },
    size: { w: disp.bounds.width, h: disp.bounds.height },
    floor: disp.workArea.y + disp.workArea.height,
    home: { x: wb.x + rect.x, y: wb.y + rect.y },
    unit: rect.width / 100, // px per Clawd viewBox unit
    visit: visit || null,
  };
  ov.setBounds(disp.bounds);
  const start = () => {
    if (!escapade || !overlayWin || overlayWin.isDestroyed()) return;
    overlayWin.setIgnoreMouseEvents(true);
    overlayWin.showInactive();
    overlayWin.setAlwaysOnTop(true, 'screen-saver');
    overlayWin.webContents.send('clawd:begin', params);
    overlayBegun = true;
    // the widget's own Clawd yields only now, so he never vanishes before the
    // overlay is ready to draw him
    if (win && !win.isDestroyed()) win.webContents.send('clawd:away');
    if (releasePending) {
      releasePending = false;
      overlayWin.webContents.send('clawd:released');
    }
    // The cursor feed runs for the whole escapade: it drives the drag, and it
    // lets the overlay notice when the mouse is over Clawd so he can be caught.
    clearInterval(cursorTimer);
    cursorTimer = setInterval(() => {
      if (overlayWin && !overlayWin.isDestroyed()) {
        overlayWin.webContents.send('clawd:cursor', screen.getCursorScreenPoint());
      }
    }, 16);
  };
  if (ov.webContents.isLoading()) ov.webContents.once('did-finish-load', start);
  else start();
  armEscapadeGuard();
}

// never leave Clawd missing from the widget if the overlay misbehaves
function armEscapadeGuard() {
  clearTimeout(escapadeGuard);
  escapadeGuard = setTimeout(endEscapade, ESCAPADE_GUARD_MS);
}

function beginEscapade(rect) {
  if (validRect(rect)) lastClawdRect = rect;
  startEscapade(rect, null);
}

// Run to a window (screen-coordinate rect) if it sits on Clawd's own display.
function beginVisit(rect) {
  if (escapade || !win || win.isDestroyed() || !lastClawdRect) return;
  const disp = screen.getDisplayMatching(win.getBounds());
  const x = Math.round((rect.left + rect.right) / 2);
  if (x < disp.bounds.x + 40 || x > disp.bounds.x + disp.bounds.width - 40) return;
  startEscapade(lastClawdRect, { x });
}

function endEscapade() {
  clearInterval(cursorTimer);
  clearTimeout(escapadeGuard);
  escapade = false;
  overlayBegun = false;
  releasePending = false;
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.setIgnoreMouseEvents(true);
    overlayWin.hide();
  }
  if (win && !win.isDestroyed()) win.webContents.send('clawd:restore');
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
      label: 'Reset sessions (clear the light)',
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
      label: installed ? 'Remove Claude Code hooks' : 'Install Claude Code hooks',
      click: () => (installed ? removeHooks(true) : installHooks(true)),
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

ipcMain.on('widget:expand', (_e, px) => {
  hoverH = Math.round(Number(px)) || 0;
});
ipcMain.on('widget:collapse', () => {
  hoverH = 0;
});
ipcMain.on('widget:focus-session', (_e, id, clawdRect) => {
  if (validRect(clawdRect)) lastClawdRect = clawdRect;
  const s = sessions.get(String(id || ''));
  if (s && s.unreadAt) {
    s.unreadAt = null;
    persistSessions();
    pushState();
  }
  focusSessionTerminal(String(id || ''));
});
ipcMain.on('clawd:warm', () => ensureOverlay()); // normally a no-op: it is resident
ipcMain.on('clawd:grab', (_e, rect) => beginEscapade(rect));
ipcMain.on('clawd:release', () => {
  if (!escapade) return;
  // released before the overlay took over (it was still loading): deliver the
  // release right after 'clawd:begin' instead of dropping it on the floor
  if (!overlayBegun) {
    releasePending = true;
    return;
  }
  if (overlayWin && !overlayWin.isDestroyed()) overlayWin.webContents.send('clawd:released');
});
// the overlay reports whether the cursor is over Clawd; only then may it take clicks
ipcMain.on('clawd:catchable', (_e, over) => {
  if (escapade && overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.setIgnoreMouseEvents(!over);
  }
});
ipcMain.on('clawd:caught', () => {
  if (escapade) armEscapadeGuard();
});
ipcMain.on('clawd:done', () => endEscapade());
ipcMain.handle('settings:get', () => ({
  port: config.port,
  sizePct: config.sizePct,
  pruneHours: config.pruneHours,
  dimIdle: !!config.dimIdle,
  clickThroughIdle: !!config.clickThroughIdle,
  notify: !!config.notify,
  notifyAfterSec: config.notifyAfterSec,
  notifySound: !!config.notifySound,
  version: app.getVersion(),
}));
ipcMain.on('settings:save', (_e, s) => applySettings(s || {}));

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
    startServer();
    createWindow();
    createTray();
    ensureOverlay(); // resident, so a grab never waits on a cold page load
    setInterval(pruneSessions, 60 * 1000);
    setInterval(syncSessions, LIVENESS_MS);
    syncSessions(); // pick up sessions already running, drop ones that died while we were away
    watchSessionsDir();
    setInterval(pollUsage, USAGE_POLL_MS);
    pollUsage();
    setInterval(pollHover, 120);
    // a docked widget follows its screen edge when the work area changes
    // (taskbar hidden/shown/resized, display added/removed, DPI change)
    screen.on('display-metrics-changed', replaceWindow);
    screen.on('display-added', replaceWindow);
    screen.on('display-removed', replaceWindow);
    initAutoUpdate();

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
    if (app.isPackaged && !config.autostartDone) {
      setAutostart(true);
      config.autostartDone = true;
      saveConfig();
    }
  });

  app.on('window-all-closed', () => app.quit());
}
