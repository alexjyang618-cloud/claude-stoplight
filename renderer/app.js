const G = window.ClawdGeometry; // the opened widget's shape, shared with main.js

const URGENT_MS = 5 * 60 * 1000; // red this long -> escalate the pulse
const SLEEPY_MS = 3 * 60 * 1000; // green this long -> Clawd dozes off
const TUCK_MS = 1500; // settling down until the z's start
const SCENE_HOLD_MS = 1400; // a tool pose stays at least this long, so rapid tool calls don't flicker
const PET_HOLD_MS = 160; // press this long -> petting
const TAP_WIGGLE_MS = 900; // a quick tap earns this much wiggle
// Background tasks reported at the end of a turn wake the session when they
// finish, which ends with a fresh report. One that has said nothing for this
// long (a dev server, a task stopped by hand) no longer keeps Clawd up.
const BG_STALE_MS = 60 * 60 * 1000;
// A usage figure this old is drawn dim, with its age in place of its reset
// time. While Claude Code is replying in a terminal the figures arrive with
// every reply, so only one that could not be refreshed gets this far.
const USAGE_STALE_MS = 15 * 60 * 1000;
// The tray opens once the pointer has rested on the lamp this long, so it
// stays shut when the pointer merely crosses it, and folds a moment after the
// pointer leaves, so a grazing exit doesn't flicker.
const OPEN_DELAY_MS = 90;
const CLOSE_DELAY_MS = 180;
const MAX_ROWS = 3; // sessions the card has room for
const ARC_MIN = 2; // a gauge that is not empty still shows a dot where it starts

const root = document.getElementById('root');
const space = document.getElementById('space');
const tray = document.getElementById('tray');
const plate = document.getElementById('plate');
const tilesG = document.getElementById('tiles-g');
const usageTile = document.getElementById('usage-tile');
const usageFace = document.getElementById('usage-face');
const cardTile = document.getElementById('tile-card');
const cardFace = document.getElementById('card-face');
const gaugesEl = document.getElementById('gauges');
const legendEl = document.getElementById('legend');
const uhintEl = document.getElementById('uhint');
const rowsEl = document.getElementById('rows');
const moreEl = document.getElementById('more');
const emptyEl = document.getElementById('empty');
const pillEl = document.getElementById('pill');
const pillLabel = document.getElementById('pill-label');
const pillTime = document.getElementById('pill-time');
const waitEl = document.getElementById('wait');
const pulseEl = document.getElementById('pulse');
const lampEl = document.getElementById('lamp');
const badge = document.getElementById('badge');
const zzzEl = document.querySelector('.zzz');
const clawdEl = document.querySelector('.clawd');
const scenes = {
  idle: document.getElementById('scene-idle'),
  think: document.getElementById('scene-think'),
  work: document.getElementById('scene-work'),
  type: document.getElementById('scene-type'),
  read: document.getElementById('scene-read'),
  stop: document.getElementById('scene-stop'),
  question: document.getElementById('scene-question'),
  stopwatch: document.getElementById('scene-stopwatch'),
  sleep: document.getElementById('scene-sleep'),
};

const STATE_CLASS = {
  off: 'state-off',
  ready: 'state-ready',
  working: 'state-working',
  permission: 'state-permission',
};

const STATE_WORD = { ready: 'ready', working: 'working', permission: 'needs you' };
const STATE_LABEL = {
  off: 'No Claude sessions',
  ready: 'Claude is ready',
  working: 'Claude is working',
  permission: 'Claude needs you',
};

// which pose a tool earns while working; anything else swings the hammer
const TOOL_SCENES = {
  Edit: 'type',
  Write: 'type',
  MultiEdit: 'type',
  NotebookEdit: 'type',
  Read: 'read',
  Grep: 'read',
  Glob: 'read',
  LS: 'read',
  WebSearch: 'read',
  WebFetch: 'read',
};

// scenes within one group swap with a minimum hold; across groups the change
// is immediate (a permission prompt must never wait behind a tool pose)
const SCENE_GROUP = {
  idle: 'idle',
  think: 'working',
  work: 'working',
  type: 'working',
  read: 'working',
  stop: 'permission',
  question: 'permission',
  stopwatch: 'background',
  sleep: 'bed',
};

let data = { state: 'off', sessions: [] };
// plan usage, from main: { bars: [{ key, label, percent, resetsAt, asOf }] }
let usage = { bars: [] };
let cfg = { scale: 1, dimIdle: false, clickThroughIdle: false, corner: 'br' };
// Sessions restored from disk can be hours old, which would put Clawd to sleep
// the instant the widget launches. He wakes up on launch and dozes SLEEPY_MS later.
const bootedAt = Date.now();
let expanded = false;

function fmtDur(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return '<1m';
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

// the same, counting the first minute in seconds: for the pills, where a wait
// that has just begun should be seen to be running
function fmtClock(ms) {
  return ms < 60000 ? `${Math.max(0, Math.floor(ms / 1000))}s` : fmtDur(ms);
}

// "3h 20m" / "2d 4h" until a reset instant
function fmtUntil(t, now) {
  const ms = t - now;
  if (!Number.isFinite(ms) || ms <= 0) return 'now';
  const m = Math.ceil(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

// "40m" / "3h" / "2d" since a figure was read
function fmtAge(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${Math.max(1, m)}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

function sessionName(s) {
  if (s.label) return s.label;
  if (s.cwd) {
    const parts = s.cwd.split(/[\\/]/).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return `session ${String(s.id).slice(0, 8)}`;
}

// the background tasks still keeping a green session busy, if any
function activeBg(s) {
  return s.state === 'ready' && Array.isArray(s.bg) && s.bg.length && Date.now() - (s.bgSince || 0) < BG_STALE_MS
    ? s.bg
    : null;
}

function idleNow() {
  return data.state === 'ready' || data.state === 'off';
}

// The tray is redrawn every couple of seconds. Its parts are kept and edited
// in place rather than rebuilt, so a row under the cursor keeps its highlight
// and a gauge can ease from one reading to the next.
function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

function setClass(el, cls) {
  if (el.getAttribute('class') !== cls) el.setAttribute('class', cls);
}

function setTitle(el, title) {
  if (el.title !== title) el.title = title;
}

function span(cls) {
  const el = document.createElement('span');
  el.className = cls;
  return el;
}

// ------------------------------------------------------------------- corners

// geometry.js describes a lamp in the bottom-right corner of the screen. For
// a lamp on the left the layout is mirrored across (fx), and for one at the
// top it is mirrored down (fy), so the tray always opens away from the
// corner. Shapes are simply flipped; text is placed at the mirrored spot and
// hung from whichever edge is now nearest the screen's.
let fx = false;
let fy = false;

function mx(x, w) {
  return fx ? G.SIZE - x - w : x;
}

function my(y, h) {
  return fy ? G.SIZE - y - h : y;
}

function box(el, x, y, w, h) {
  el.style.left = `${mx(x, w)}px`;
  el.style.top = `${my(y, h)}px`;
  el.style.width = `${w}px`;
  el.style.height = `${h}px`;
}

// a block as wide as its text, hung from its lamp-side edge at x
function hang(el, edge, y, h) {
  el.style.left = fx ? `${G.SIZE - edge}px` : 'auto';
  el.style.right = fx ? 'auto' : `${G.SIZE - edge}px`;
  el.style.top = `${my(y, h)}px`;
}

const OPPOSITE = { br: 'tl', bl: 'tr', tr: 'bl', tl: 'br' };
const SVG_NS = 'http://www.w3.org/2000/svg';
const SLOTS = ['session', 'weekly', 'model']; // outer gauge first
let gaugeParts = [];

function svgPath(cls, d) {
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('class', cls);
  p.setAttribute('d', d);
  return p;
}

// the tiles and gauges are drawn once; layout() only turns them to the corner
function buildTray() {
  document.getElementById('tile-usage').setAttribute('d', G.usagePath);
  document.getElementById('tile-card').setAttribute('d', G.cardPath);
  gaugeParts = G.gauges.map((g) => {
    const fill = svgPath('gfill', g.d);
    fill.setAttribute('pathLength', '100');
    const track = svgPath('gtrack', g.d);
    gaugesEl.append(track, fill);
    const row = document.createElement('div');
    row.className = 'lrow';
    row.setAttribute('role', 'meter');
    row.setAttribute('aria-valuemin', '0');
    row.setAttribute('aria-valuemax', '100');
    const main = span('lmain');
    const parts = { track, fill, row, label: span('llabel'), val: span('lval'), rest: span('lrest'), rowY: g.rowY };
    main.append(parts.label, parts.val);
    row.append(main, parts.rest);
    legendEl.append(row);
    return parts;
  });
}

function layout() {
  const corner = OPPOSITE[cfg.corner] ? cfg.corner : 'br';
  fx = corner[1] === 'l';
  fy = corner[0] === 't';
  space.classList.toggle('fx', fx);
  space.classList.toggle('fy', fy);
  // the tray sits MARGIN in from the window's two edges nearest the screen corner
  const far = G.WINDOW - G.MARGIN - G.SIZE;
  space.style.left = `${fx ? G.MARGIN : far}px`;
  space.style.top = `${fy ? G.MARGIN : far}px`;
  // a quarter-disc: its one big corner faces away from the lamp, and the
  // lamp's own corner is concentric with the lamp
  const r = { tl: 22, tr: 22, br: 22, bl: 22 };
  r[corner] = G.LAMP_R + G.GAP;
  r[OPPOSITE[corner]] = G.trayRadius;
  plate.style.borderRadius = `${r.tl}px ${r.tr}px ${r.br}px ${r.bl}px`;
  tilesG.setAttribute(
    'transform',
    `translate(${fx ? G.SIZE : 0} ${fy ? G.SIZE : 0}) scale(${fx ? -1 : 1} ${fy ? -1 : 1})`
  );
  // the tray opens out of the lamp's circle
  tray.style.setProperty('--ox', `${mx(G.D, 0)}px`);
  tray.style.setProperty('--oy', `${my(G.D, 0)}px`);
  // A tile swells under the pointer about its own middle, and what is written
  // on it about the same point: the shapes in geometry.js's coordinates (they
  // are flipped as a group), the text in the mirrored ones.
  const { usage: um, card: cm } = G.middle;
  usageTile.style.transformOrigin = `${um.x}px ${um.y}px`;
  cardTile.style.transformOrigin = `${cm.x}px ${cm.y}px`;
  usageFace.style.transformOrigin = `${mx(um.x, 0)}px ${my(um.y, 0)}px`;
  cardFace.style.transformOrigin = `${mx(cm.x, 0)}px ${my(cm.y, 0)}px`;
  for (const p of gaugeParts) {
    box(p.row, G.legend.left, p.rowY - G.legend.rowH / 2, G.legend.right - G.legend.left, G.legend.rowH);
  }
  box(uhintEl, G.legend.left, gaugeParts[0].rowY - G.legend.rowH / 2, G.legend.right - G.legend.left, 46);
  box(pillEl, G.pill.left, G.pill.top, G.pill.width, G.pill.height);
  box(lampEl, G.D - G.LAMP_R, G.D - G.LAMP_R, 2 * G.LAMP_R, 2 * G.LAMP_R);
  box(pulseEl, G.D - 24, G.D - 24, 48, 48);
  hang(waitEl, G.D - G.DOT_R - 4, G.D - G.DOT_R, 2 * G.DOT_R);
  hang(badge, G.D - G.DOT_R + 12, G.D - G.DOT_R - 6, 18);
  box(zzzEl, G.D + 2, G.D - G.LAMP_R - 30, 26, 32);
}

// --------------------------------------------------------------------- usage

function renderUsage(now) {
  const byKey = new Map((usage.bars || []).map((b) => [b.key, b]));
  let any = false;
  SLOTS.forEach((key, i) => {
    const b = byKey.get(key);
    const p = gaugeParts[i];
    p.row.hidden = !b;
    p.track.style.display = b ? '' : 'none';
    p.fill.style.display = b ? '' : 'none';
    if (!b) return;
    any = true;
    // a window that has reset since it was read starts again from nothing
    const rolled = Boolean(b.resetsAt && now >= b.resetsAt);
    const percent = rolled ? 0 : b.percent;
    const stale = !rolled && now - (b.asOf || 0) >= USAGE_STALE_MS;
    const level = percent >= 90 ? ' high' : percent >= 75 ? ' warn' : '';
    setClass(p.fill, `gfill${level}${stale ? ' stale' : ''}`);
    p.fill.style.strokeDashoffset = String(100 - Math.min(100, Math.max(percent > 0 ? ARC_MIN : 0, percent)));
    setClass(p.row, `lrow${stale ? ' stale' : ''}`);
    setText(p.label, b.label);
    setText(p.val, `${percent}%`);
    setText(p.rest, stale ? `${fmtAge(now - b.asOf)} ago` : !rolled && b.resetsAt ? fmtUntil(b.resetsAt, now) : '');
    p.row.setAttribute('aria-label', `${b.label} usage`);
    p.row.setAttribute('aria-valuenow', String(percent));
    setTitle(
      p.row,
      [
        `${b.label} usage: ${percent}%`,
        !rolled && b.resetsAt ? `Resets ${new Date(b.resetsAt).toLocaleString()}` : '',
        stale ? `As of ${new Date(b.asOf).toLocaleString()}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    );
  });
  uhintEl.hidden = any;
}

// ------------------------------------------------------------------ sessions

const rowParts = new Map(); // session id -> its row and the pieces inside it

function makeRow(id) {
  const row = document.createElement('div');
  row.setAttribute('role', 'button');
  row.tabIndex = 0;
  const parts = {
    row,
    text: span('rtext'),
    l1: span('l1'),
    dur: span('dur'),
    name: span('name'),
    l2: span('l2'),
    bead: span('bead'),
  };
  parts.l1.append(parts.dur, parts.name);
  parts.text.append(parts.l1, parts.l2);
  row.append(parts.text, parts.bead);
  row.addEventListener('click', () => window.stoplight.focusSession(id));
  row.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    row.click();
  });
  return parts;
}

function updateRow(parts, s, now) {
  const finished = Boolean(s.state === 'ready' && s.unread);
  const bg = activeBg(s);
  setClass(parts.bead, `bead ${finished ? 'finished' : s.state}`);
  setText(parts.dur, fmtDur(now - s.since));
  setText(parts.name, sessionName(s));
  // line two: its state, then the tool call or question it is on, or its
  // background tasks
  const word = finished ? 'finished' : bg ? 'background' : STATE_WORD[s.state] || s.state;
  const doing = s.state === 'ready' ? null : s.detail;
  const what = doing || (bg && (bg.length > 1 ? `${bg[0]} (+${bg.length - 1} more)` : bg[0])) || '';
  setText(parts.l2, what ? `${word} · ${what}` : word);
  setTitle(parts.row, [s.cwd, doing, ...(bg || []), 'Click to focus its terminal'].filter(Boolean).join('\n'));
}

// The card narrows as it climbs away from the lamp, so each line of each row
// gets the width the card has at that height. Rows stack from the lamp
// outwards, most urgent first, the stack centred in the card.
function renderRows(now) {
  const list = data.sessions;
  const shown = list.slice(0, MAX_ROWS);
  const extra = list.length - shown.length;
  const hero = list.length === 1;
  const tight = extra > 0;
  const l1 = hero ? 19 : tight ? 16 : 17;
  const l2 = hero ? 16 : tight ? 13 : 14;
  const gap = tight ? 2 : 4;
  const rowH = l1 + l2;
  const moreH = 13;
  const total = shown.length * rowH + Math.max(0, shown.length - 1) * gap + (extra ? moreH + 3 : 0);
  let bottom = G.card.bottom - (G.card.height - total) / 2;
  const textEdge = G.card.textEdge - 8 - 6; // inside the bead and its gap

  const live = new Set();
  shown.forEach((s, i) => {
    let parts = rowParts.get(s.id);
    if (!parts) rowParts.set(s.id, (parts = makeRow(s.id)));
    updateRow(parts, s, now);
    setClass(parts.row, `row${hero ? ' hero' : ''}${tight ? ' tight' : ''}`);
    const top = bottom - rowH;
    // the row's own padding (2px 6px) lies outside the text
    hang(parts.row, G.card.textEdge + 6, top - 2, rowH + 4);
    // line one sits above line two on screen, which is the far side of the
    // row for a lamp at the bottom and the near side for one at the top
    const far1 = fy ? top + l2 : top;
    const far2 = fy ? top : top + l1;
    parts.l1.style.maxWidth = `${Math.max(24, Math.floor(textEdge - G.cardLimit(far1)))}px`;
    parts.l2.style.maxWidth = `${Math.max(24, Math.floor(textEdge - G.cardLimit(far2)))}px`;
    if (rowsEl.children[i] !== parts.row) rowsEl.insertBefore(parts.row, rowsEl.children[i] || null);
    live.add(s.id);
    bottom = top - gap;
  });
  for (const [id, parts] of rowParts) {
    if (live.has(id)) continue;
    parts.row.remove();
    rowParts.delete(id);
  }

  moreEl.hidden = extra <= 0;
  if (extra > 0) {
    setText(moreEl, `+${extra} more`);
    setTitle(moreEl, list.slice(MAX_ROWS).map((s) => `${sessionName(s)} · ${STATE_WORD[s.state] || s.state}`).join('\n'));
    hang(moreEl, G.card.textEdge, bottom - 3 - moreH + gap, moreH);
  }
  emptyEl.hidden = list.length > 0;
  if (!list.length) hang(emptyEl, G.card.textEdge, G.card.bottom - G.card.height / 2 - 9, 17);
}

// ---------------------------------------------------------------- the pill

// The state in a word and how long it has held: the oldest wait, the longest
// turn still running, or how long Claude has been ready.
function status(now) {
  const list = data.sessions;
  if (data.state === 'permission') {
    const waiting = list.filter((s) => s.state === 'permission');
    const since = Math.min(now, ...waiting.map((s) => s.since));
    const question = waiting.length > 0 && waiting.every((s) => s.waitKind === 'question');
    return { label: question ? 'Question' : 'Needs you', ms: now - since };
  }
  if (data.state === 'working') {
    const since = Math.min(now, ...list.filter((s) => s.state === 'working').map((s) => s.since));
    return { label: 'Working', ms: now - since };
  }
  if (data.state === 'ready' && list.length) {
    const since = Math.max(...list.map((s) => s.since));
    const finished = list.filter((s) => s.unread).length;
    if (finished) return { label: finished > 1 ? `${finished} finished` : 'Finished', ms: now - since };
    if (list.some(activeBg)) return { label: 'Background', ms: now - since };
    return { label: 'Ready', ms: now - since };
  }
  return { label: 'No sessions', ms: null };
}

// --------------------------------------------------------------- pixel grid

// Clawd is a 12 x 8 grid of pixels drawn 8 viewBox units to a cell. He is
// sized so that a cell is a whole number of device pixels (2 at 100% on a 1x
// display), and placed on a whole device pixel, so every cell comes out the
// same size. style.css rounds each of his moves to device pixels the same
// way, using --dp (a device pixel in his viewBox) and --cp (one in CSS px
// under #root's zoom). All of it changes with the widget size and the
// display's scale.
const CLAWD_MID_X = 52; // the middle of his body, in his 100-unit box
const CLAWD_MID_Y = 66;

function setPixelGrid() {
  const devPerPx = cfg.scale * (window.devicePixelRatio || 1);
  const cell = Math.max(1, Math.round(2 * devPerPx));
  const size = (12.5 * cell) / devPerPx; // his 100 units
  const unit = size / 100;
  const snap = (v) => Math.round(v * devPerPx) / devPerPx;
  clawdEl.style.width = `${size}px`;
  clawdEl.style.height = `${size}px`;
  clawdEl.style.left = `${snap(G.LAMP_R - CLAWD_MID_X * unit)}px`;
  clawdEl.style.top = `${snap(G.LAMP_R - CLAWD_MID_Y * unit)}px`;
  clawdEl.style.setProperty('--dp', `${8 / cell}px`);
  clawdEl.style.setProperty('--cp', `${1 / devPerPx}px`);
  clawdEl.style.setProperty('--eye-shut', String(1 / cell));
}

// dragging the widget to a display with another scale changes the ratio
let dprQuery = null;
function watchPixelRatio() {
  dprQuery?.removeEventListener('change', onPixelRatio);
  dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
  dprQuery.addEventListener('change', onPixelRatio);
}
function onPixelRatio() {
  setPixelGrid();
  watchPixelRatio();
}

// ------------------------------------------------------------------- scenes

// null until the first render: updateScene() short-circuits when the wanted
// scene already equals shownScene, and no scene carries `.on` until showScene()
// runs, so pre-setting this to 'idle' left Clawd invisible at launch.
let shownScene = null;
let sceneShownAt = 0;
let sceneTimer = null;
let sleepy = false;
let sleepySince = 0;

function sceneFor() {
  if (sleepy) return 'sleep';
  if (data.state === 'working') {
    // follow whatever the most recently active working session is doing
    const s = data.sessions
      .filter((x) => x.state === 'working')
      .sort((a, b) => (b.lastEvent || 0) - (a.lastEvent || 0))[0];
    if (!s || !s.tool) return 'think';
    return TOOL_SCENES[s.tool] || 'work';
  }
  if (data.state === 'permission') {
    const hardStop = data.sessions.some((x) => x.state === 'permission' && x.waitKind !== 'question');
    return hardStop ? 'stop' : 'question';
  }
  if (data.state === 'ready' && data.sessions.some(activeBg)) return 'stopwatch';
  return 'idle';
}

function showScene(name) {
  const woke = shownScene === 'sleep' && name !== 'sleep';
  for (const [key, el] of Object.entries(scenes)) el.classList.toggle('on', key === name);
  shownScene = name;
  sceneShownAt = Date.now();
  if (woke) oneShot('hop'); // startled awake
}

function updateScene() {
  const want = sceneFor();
  if (want === shownScene) {
    clearTimeout(sceneTimer);
    sceneTimer = null;
    return;
  }
  const sameGroup = SCENE_GROUP[want] === SCENE_GROUP[shownScene];
  const wait = sameGroup ? SCENE_HOLD_MS - (Date.now() - sceneShownAt) : 0;
  if (wait <= 0) {
    clearTimeout(sceneTimer);
    sceneTimer = null;
    showScene(want);
  } else if (!sceneTimer) {
    sceneTimer = setTimeout(() => {
      sceneTimer = null;
      updateScene();
    }, wait);
  }
}

// -------------------------------------------------------------------- render

let lastLive = '';

// Tell main which part of the window is the widget right now, so it can tell
// when the pointer is over it: the opened tray, or the lamp and however far
// the wait pill reaches beside it.
function reportLive() {
  const reach = expanded || waitEl.hidden ? 0 : Math.ceil(G.DOT_R + 4 + waitEl.offsetWidth);
  const key = `${expanded}:${reach}`;
  if (key === lastLive) return;
  lastLive = key;
  window.stoplight.live({ open: expanded, reach });
}

function render() {
  const now = Date.now();
  const st = status(now);
  const urgent = data.state === 'permission' && st.ms >= URGENT_MS;
  // background tasks keep him up: they will wake a session when they finish
  const idleMs =
    data.state === 'ready' && data.sessions.length && !data.sessions.some(activeBg)
      ? now - Math.max(bootedAt, ...data.sessions.map((s) => s.since))
      : 0;
  const nowSleepy = idleMs >= SLEEPY_MS;
  if (nowSleepy && !sleepy) sleepySince = now;
  sleepy = nowSleepy;
  setClass(
    space,
    [
      STATE_CLASS[data.state] || 'state-off',
      urgent && 'urgent',
      sleepy && 'sleepy',
      sleepy && now - sleepySince >= TUCK_MS && 'asleep',
      idleNow() && cfg.dimIdle && 'dim',
      expanded && 'open',
      fx && 'fx',
      fy && 'fy',
    ]
      .filter(Boolean)
      .join(' ')
  );
  updateScene();

  // at rest: the wait beside the lamp, and the count of finished turns on it
  const finished = data.sessions.filter((s) => s.state === 'ready' && s.unread).length;
  badge.hidden = finished === 0;
  setText(badge, finished > 1 ? String(finished) : '');
  waitEl.hidden = data.state !== 'permission';
  if (!waitEl.hidden) setText(waitEl, fmtClock(st.ms));
  const names = data.sessions.filter((s) => s.state === data.state).map(sessionName);
  lampEl.setAttribute(
    'aria-label',
    `${STATE_LABEL[data.state] || STATE_LABEL.off}${names.length ? `: ${names.join(', ')}` : ''}`
  );

  // The tray is kept current while it is shut, so it opens already right and
  // never holds on to a session that has gone. Shut, its gauges are drawn
  // empty; they sweep up to their readings as it opens.
  setText(pillLabel, st.label);
  setText(pillTime, st.ms === null ? '' : fmtClock(st.ms));
  // the time is set large; when that would crowd the label out, it steps down
  pillTime.classList.remove('long');
  if (pillLabel.scrollWidth > pillLabel.clientWidth) pillTime.classList.add('long');
  renderUsage(now);
  renderRows(now);
  reportLive();
}

function setExpanded(next) {
  if (next === expanded) return;
  expanded = next;
  tray.inert = !expanded; // shut, its rows are out of reach of the keyboard too
  render();
  showHot();
}

// ---------------------------------------------------------- under the pointer

// Which tile the pointer is on ('usage', 'card', 'pill', 'lamp', or none),
// from main: most of the tray is a drag region, which never sees the mouse.
// style.css swells that tile a little.
let hot = null;

function showHot() {
  const next = expanded && hot ? hot : '';
  if ((space.dataset.hot || '') !== next) space.dataset.hot = next;
}

window.stoplight.onHot((tile) => {
  hot = tile || null;
  showHot();
});

// ---------------------------------------------------------------- reactions

// One-shot keyframe animations on the Clawd box; the class comes off when the
// animation ends so the next one can play.
const REACTION_CLASS = { done: 'hop', flinch: 'flinch' };
const ONE_SHOTS = new Set(['hop', 'flinch']);

function oneShot(cls) {
  clawdEl.classList.remove(cls);
  void clawdEl.offsetWidth; // restart the animation if it is already running
  clawdEl.classList.add(cls);
}

clawdEl.addEventListener('animationend', (e) => {
  if (e.target === clawdEl && ONE_SHOTS.has(e.animationName)) clawdEl.classList.remove(e.animationName);
});

window.stoplight.onReact(({ type }) => {
  const cls = REACTION_CLASS[type];
  if (cls) oneShot(cls);
});

// ------------------------------------------------------------------ petting

// Press and hold the opened lamp and he wiggles happily; a quick tap earns a
// short one. The wiggle is a pair of alternating tilt classes rather than a
// keyframe loop, so letting go puts him straight back from whichever side he
// is on.
let wiggleTimer = null;
let wiggleSide = 1;
let happyTimer = null;
let press = null; // the pointer holding the lamp down
let petTimer = null;
let petting = false;

function startWiggle() {
  stopWiggle();
  const tick = () => {
    wiggleSide = -wiggleSide;
    clawdEl.classList.toggle('tilt-l', wiggleSide < 0);
    clawdEl.classList.toggle('tilt-r', wiggleSide > 0);
  };
  tick();
  wiggleTimer = setInterval(tick, 450);
  clearTimeout(happyTimer);
  clawdEl.classList.add('happy');
}

function stopWiggle(lingerMs = 400) {
  clearInterval(wiggleTimer);
  wiggleTimer = null;
  clawdEl.classList.remove('tilt-l', 'tilt-r');
  clearTimeout(happyTimer);
  happyTimer = setTimeout(() => clawdEl.classList.remove('happy'), lingerMs);
}

lampEl.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !expanded) return;
  press = e.pointerId;
  try {
    lampEl.setPointerCapture(e.pointerId);
  } catch {}
  clearTimeout(petTimer);
  petTimer = setTimeout(() => {
    petTimer = null;
    if (press !== null) {
      petting = true;
      startWiggle();
    }
  }, PET_HOLD_MS);
});

function endPress(e) {
  if (press === null || e.pointerId !== press) return;
  press = null;
  const quickTap = petTimer !== null;
  clearTimeout(petTimer);
  petTimer = null;
  if (petting) {
    petting = false;
    stopWiggle();
  } else if (quickTap) {
    startWiggle();
    setTimeout(() => {
      if (!petting) stopWiggle();
    }, TAP_WIGGLE_MS);
  }
  if (!hovering) scheduleClose();
}
lampEl.addEventListener('pointerup', endPress);
lampEl.addEventListener('pointercancel', endPress);
// a press that loses the pointer (another window took over) is over too,
// or the tray would stay open and he would wiggle until the next click
lampEl.addEventListener('lostpointercapture', endPress);
window.addEventListener('blur', () => {
  if (press !== null) endPress({ pointerId: press });
});

// --------------------------------------------------------------------- hover

// Hover comes from the main process, which polls the cursor against the
// widget's shape — immune to per-pixel hit-testing, which keeps parts of a
// transparent window from ever seeing the mouse.
let hovering = false;
let openTimer = null;
let closeTimer = null;

function scheduleClose() {
  if (!expanded || closeTimer) return;
  closeTimer = setTimeout(() => {
    closeTimer = null;
    if (!hovering && press === null) setExpanded(false);
  }, CLOSE_DELAY_MS);
}

window.stoplight.onHover((over) => {
  hovering = Boolean(over);
  if (hovering) {
    clearTimeout(closeTimer);
    closeTimer = null;
    if (!expanded && !openTimer) {
      openTimer = setTimeout(() => {
        openTimer = null;
        if (hovering) setExpanded(true);
      }, OPEN_DELAY_MS);
    }
  } else {
    clearTimeout(openTimer);
    openTimer = null;
    if (press === null) scheduleClose();
  }
});

// keep the wait timer / row durations / dozing fresh
setInterval(render, 2000);

window.stoplight.onState((d) => {
  data = d;
  render();
});
window.stoplight.onUsage((u) => {
  usage = u || { bars: [] };
  render();
});
window.stoplight.onConfig((c) => {
  cfg = Object.assign({}, cfg, c);
  root.style.zoom = cfg.scale;
  layout();
  setPixelGrid();
  render();
});

buildTray();
layout();
setPixelGrid();
watchPixelRatio();
render();
