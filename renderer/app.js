const BASE_H = 124; // widget design height in CSS px (matches main.js)
const URGENT_MS = 5 * 60 * 1000; // red this long -> escalate the pulse
const SLEEPY_MS = 3 * 60 * 1000; // green this long -> Clawd dozes off
const SCENE_HOLD_MS = 1400; // a tool pose stays at least this long, so rapid tool calls don't flicker
const PET_HOLD_MS = 160; // press this long without dragging -> petting
const TAP_WIGGLE_MS = 900; // a quick tap earns this much wiggle
// Background tasks reported at the end of a turn wake the session when they
// finish, which ends with a fresh report. One that has said nothing for this
// long (a dev server, a task stopped by hand) no longer keeps Clawd up.
const BG_STALE_MS = 60 * 60 * 1000;
// Usage figures this old, with the last refresh failed, get a note saying so.
// Main refreshes them every three minutes, so this is several misses in a row.
const USAGE_GRACE_MS = 10 * 60 * 1000;

const root = document.getElementById('root');
const widget = document.getElementById('widget');
const panel = document.getElementById('panel');
const gaugeEl = document.getElementById('gauge');
const arcsEl = document.getElementById('arcs');
const readoutsEl = document.getElementById('readouts');
const unoteEl = document.getElementById('unote');
const rowsEl = document.getElementById('rows');
const chip = document.getElementById('wait-chip');
const badge = document.getElementById('done-badge');
const clawdEl = document.querySelector('.clawd');
const lamps = {
  red: document.querySelector('.lamp.red'),
  yellow: document.querySelector('.lamp.yellow'),
  green: document.querySelector('.lamp.green'),
};
const scenes = {
  idle: document.getElementById('scene-idle'),
  think: document.getElementById('scene-think'),
  work: document.getElementById('scene-work'),
  type: document.getElementById('scene-type'),
  read: document.getElementById('scene-read'),
  stop: document.getElementById('scene-stop'),
  question: document.getElementById('scene-question'),
  stopwatch: document.getElementById('scene-stopwatch'),
  bedwalk: document.getElementById('scene-bedwalk'),
  sleep: document.getElementById('scene-sleep'),
};
const props = document.getElementById('scene-props'); // nightcap, teddy, blanket falling away

const STATE_CLASS = {
  off: 'state-off',
  ready: 'state-ready',
  working: 'state-working',
  permission: 'state-permission',
};

const STATE_WORD = { ready: 'ready', working: 'working', permission: 'needs you' };

// which lamp survives when the stoplight collapses to a single circle
const ACTIVE_LAMP = { off: 'green', ready: 'green', working: 'yellow', permission: 'red' };

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
  bedwalk: 'bed',
  sleep: 'bed',
};

let data = { state: 'off', sessions: [] };
let usage = { bars: [], fetchedAt: 0, error: null }; // plan usage bars, from main
let cfg = { zoom: 0.7, dimIdle: false, clickThroughIdle: false };
// Sessions restored from disk can be hours old, which would put Clawd to sleep
// the instant the widget launches. He wakes up on launch and dozes SLEEPY_MS later.
const bootedAt = Date.now();
let expanded = false;
let lastSentHeight = 0;

function fmtDur(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return '<1m';
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
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

function clawdRect() {
  const r = clawdEl.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}

// The panel is redrawn every couple of seconds. Its parts are kept and edited
// in place rather than rebuilt, so a row under the cursor keeps its highlight
// and the gauge can ease from one reading to the next.
function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

function span(cls) {
  const el = document.createElement('span');
  el.className = cls;
  return el;
}

const rowParts = new Map(); // session id -> its row and the pieces inside it

function makeRow(id) {
  const row = document.createElement('div');
  row.className = 'row';
  row.setAttribute('role', 'button');
  row.tabIndex = 0;
  const parts = { row, dot: span('dot'), name: span('name'), meta: span('meta'), sub: span('sub') };
  row.append(parts.dot, parts.name, parts.meta, parts.sub);
  row.addEventListener('click', () => window.stoplight.focusSession(id, clawdRect()));
  row.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    row.click();
  });
  return parts;
}

function updateRow({ row, dot, name, meta, sub }, s) {
  const finished = Boolean(s.state === 'ready' && s.unread);
  const bg = activeBg(s);
  row.classList.toggle('finished', finished);
  const dotClass = `dot ${s.state}`;
  if (dot.className !== dotClass) dot.className = dotClass;
  setText(name, sessionName(s));
  const word = finished ? 'finished' : bg ? 'background' : STATE_WORD[s.state] || s.state;
  setText(meta, `${word} · ${fmtDur(Date.now() - s.since)}`);
  // second line: the tool call or question it is on, or its background tasks
  const doing = s.state === 'ready' ? null : s.detail;
  const subText = doing || (bg && (bg.length > 1 ? `${bg[0]} (+${bg.length - 1} more)` : bg[0])) || '';
  setText(sub, subText);
  sub.hidden = !subText;
  const title = [s.cwd, doing, ...(bg || []), 'Click to focus its terminal'].filter(Boolean).join('\n');
  if (row.title !== title) row.title = title;
}

function syncRows() {
  const live = new Set();
  data.sessions.forEach((s, i) => {
    let parts = rowParts.get(s.id);
    if (!parts) rowParts.set(s.id, (parts = makeRow(s.id)));
    updateRow(parts, s);
    if (rowsEl.children[i] !== parts.row) rowsEl.insertBefore(parts.row, rowsEl.children[i] || null);
    live.add(s.id);
  });
  for (const [id, parts] of rowParts) {
    if (live.has(id)) continue;
    parts.row.remove();
    rowParts.delete(id);
  }
}

// "3h 20m" / "2d 4h" until a reset instant
function fmtUntil(t) {
  const ms = t - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return 'now';
  const m = Math.ceil(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

// ------------------------------------------------------------- usage gauge

// The panel's crown is a half-disc, and its rim is the gauge: the limits share
// the arc end to end, each filling clockwise like a dial, with its reading set
// on the radius underneath. Geometry is in the panel's CSS px (244 wide, so
// the crown's centre sits at 122,122); angles run counter-clockwise from
// three o'clock.
const SVG_NS = 'http://www.w3.org/2000/svg';
const DOME_R = 122;
const ARC_R = 112; // the track's centre line: 6px wide, 7px in from the rim
const ARC_FROM = 176; // the ends stop short of the baseline, clear of the rows
const ARC_TO = 4;
const ARC_GAP = 7; // between neighbouring arcs, before their round caps
const ARC_MIN = 2; // an empty arc still shows a dot where it starts
// how far out from the centre the readings sit: the middle one of three hangs
// a little lower, so the three never crowd
const READ_R = 66;
const READ_R_TOP = 61;
const READ_W = 62; // a reading's width, while its neighbours leave room

function onDome(r, deg) {
  const a = (deg * Math.PI) / 180;
  return { x: DOME_R + r * Math.cos(a), y: DOME_R - r * Math.sin(a) };
}

function arcPath(from, to) {
  const a = onDome(ARC_R, from);
  const b = onDome(ARC_R, to);
  return `M${a.x.toFixed(2)} ${a.y.toFixed(2)}A${ARC_R} ${ARC_R} 0 0 1 ${b.x.toFixed(2)} ${b.y.toFixed(2)}`;
}

function svgPath(cls, d) {
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('class', cls);
  p.setAttribute('d', d);
  return p;
}

let gaugeKeys = null; // the limits the gauge is currently drawn for
let gaugeParts = [];

function buildGauge(bars) {
  const n = bars.length;
  const sweep = (ARC_FROM - ARC_TO - ARC_GAP * (n - 1)) / n;
  // Three limits is what the API reports today. Were there more, each reading
  // narrows to the chord between itself and its neighbour and sets smaller,
  // so they still cannot run into each other.
  const chord = 2 * READ_R * Math.sin(((sweep + ARC_GAP) * Math.PI) / 360);
  const width = n > 3 ? Math.min(READ_W, chord - 4) : READ_W;
  readoutsEl.classList.toggle('dense', n > 3);
  arcsEl.replaceChildren();
  readoutsEl.replaceChildren();
  gaugeParts = bars.map((_, i) => {
    const from = ARC_FROM - i * (sweep + ARC_GAP);
    const d = arcPath(from, from - sweep);
    const fill = svgPath('gfill', d);
    fill.setAttribute('pathLength', '100');
    arcsEl.append(svgPath('gtrack', d), fill);
    const mid = from - sweep / 2;
    const at = onDome(n === 3 && i === 1 ? READ_R_TOP : READ_R, mid);
    const read = document.createElement('div');
    read.className = 'readout';
    read.setAttribute('role', 'meter');
    read.setAttribute('aria-valuemin', '0');
    read.setAttribute('aria-valuemax', '100');
    read.style.left = `${at.x.toFixed(1)}px`;
    read.style.top = `${at.y.toFixed(1)}px`;
    read.style.width = `${width.toFixed(1)}px`;
    const parts = { fill, read, label: span('rlabel'), pct: span('rpct'), reset: span('rreset') };
    read.append(parts.label, parts.pct, parts.reset);
    readoutsEl.append(read);
    return parts;
  });
}

function renderGauge() {
  const bars = usage.bars;
  gaugeEl.hidden = bars.length === 0;
  const keys = bars.map((b) => b.key).join('|');
  if (keys !== gaugeKeys) {
    gaugeKeys = keys;
    buildGauge(bars);
  }
  bars.forEach((b, i) => {
    const { fill, read, label, pct, reset } = gaugeParts[i];
    const level = b.percent >= 80 ? ' high' : b.percent >= 50 ? ' warn' : '';
    if (fill.getAttribute('class') !== `gfill${level}`) fill.setAttribute('class', `gfill${level}`);
    fill.style.strokeDashoffset = String(100 - Math.min(100, Math.max(ARC_MIN, b.percent)));
    setText(label, b.label);
    setText(pct, String(b.percent)); // style.css appends the % sign, set smaller
    setText(reset, b.resetsAt ? fmtUntil(b.resetsAt) : '');
    reset.hidden = !b.resetsAt;
    read.setAttribute('aria-label', `${b.label} usage`);
    read.setAttribute('aria-valuenow', String(b.percent));
    const title = `${b.label} usage: ${b.percent}%` + (b.resetsAt ? `\nResets ${new Date(b.resetsAt).toLocaleString()}` : '');
    if (read.title !== title) read.title = title;
  });
  // A failed fetch keeps the last numbers up. It is only worth saying so once
  // they are old enough to mislead: a refresh that fails now and then (the
  // usage endpoint rate limits) passes unnoticed, and main retries by itself.
  const stale = Boolean(usage.error) && (!usage.fetchedAt || Date.now() - usage.fetchedAt >= USAGE_GRACE_MS);
  unoteEl.hidden = !stale;
  if (stale) {
    setText(
      unoteEl,
      usage.fetchedAt ? `${usage.error} · showing figures from ${fmtDur(Date.now() - usage.fetchedAt)} ago` : usage.error
    );
  }
}

// The session panel sits just above whatever Clawd is wearing or holding.
// Distances are CSS px down from the top of #widget, from style.css: 124px
// tall with 14px bottom padding, an 86px Clawd box drawn in 100 units, and a
// 50px-tall light.
const FLOOR = BASE_H - 14;
const CLAWD_TOP = FLOOR - 86;
const CLAWD_UNIT = 86 / 100;
const LIGHT_TOP = FLOOR - 50;
const PANEL_GAP = 10;
// How high each pose reaches in his drawing (y in its 100-unit box). The poses
// Claude flips between while working share the tallest, so the panel doesn't
// hop with every tool call (the thinking bulb tucks under it).
const POSE_REACH = { idle: 36, stopwatch: 36, think: 9, work: 9, type: 9, read: 9, stop: 36, question: 4, bedwalk: 4, sleep: 33 };
let panelBottom = -6; // the panel's bottom edge, down from the widget's top

function placePanel() {
  const reach = POSE_REACH[shownScene] ?? 36;
  panelBottom = Math.min(CLAWD_TOP + reach * CLAWD_UNIT, LIGHT_TOP) - PANEL_GAP;
  panel.style.marginBottom = `${-panelBottom}px`;
}

function renderPanel() {
  const show = expanded && (data.sessions.length > 0 || usage.bars.length > 0 || Boolean(usage.error));
  // The panel is kept current while it is shut, so it opens already right and
  // never holds on to a session that has gone. Shut, its arcs are drawn
  // empty; they sweep up to their readings as it opens.
  renderGauge();
  syncRows();
  panel.classList.toggle('crowned', usage.bars.length > 0);
  panel.classList.toggle('has-rows', data.sessions.length > 0);
  panel.classList.toggle('open', show);
  panel.inert = !show; // shut, its rows are out of reach of the keyboard too
  if (!show) {
    if (lastSentHeight) {
      lastSentHeight = 0;
      window.stoplight.collapse(); // shrinks the hover region back to the widget
    }
    return;
  }
  requestAnimationFrame(() => {
    if (!expanded) return;
    // tell main how tall the live (hoverable) region is now
    const total = Math.round((BASE_H - panelBottom + panel.offsetHeight + 2) * cfg.zoom);
    if (total !== lastSentHeight) {
      lastSentHeight = total;
      window.stoplight.expand(total);
    }
  });
}

// --------------------------------------------------------------- pixel grid

// style.css rounds every one of Clawd's moves to whole device pixels, so each
// edge of his drawing shifts by the same amount and no part of him grows or
// shrinks as he steps. These tell it how big a device pixel is: in his
// 100-unit viewBox (--dp) and in CSS px under #root's zoom (--cp). Both
// change with the widget size and with the display's scale.
const BED_WALK_PX = 170; // how far he walks off at bedtime, CSS px
const EYE_UNITS = 8; // an eye's height in his viewBox

function setPixelGrid() {
  const devPerCss = cfg.zoom * (window.devicePixelRatio || 1);
  const devPerUnit = CLAWD_UNIT * devPerCss;
  clawdEl.style.setProperty('--dp', `${1 / devPerUnit}px`);
  clawdEl.style.setProperty('--cp', `${1 / devPerCss}px`);
  clawdEl.style.setProperty('--eye-shut', String(1 / (EYE_UNITS * devPerUnit)));
  clawdEl.style.setProperty('--walk-steps', String(Math.max(1, Math.round(BED_WALK_PX * devPerCss))));
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
setPixelGrid();
watchPixelRatio();

// ------------------------------------------------------------------- scenes

// null until the first render: updateScene() short-circuits when the wanted
// scene already equals shownScene, and no scene carries `.on` until showScene()
// runs, so pre-setting this to 'idle' left Clawd invisible at launch.
let shownScene = null;
let sceneShownAt = 0;
let sceneTimer = null;

function sceneFor() {
  // bedtime overrides the state-driven pose until he is startled awake
  if (bedtime === 'leaving' || bedtime === 'away' || bedtime === 'returning') return 'bedwalk';
  if (bedtime === 'lying' || bedtime === 'asleep') return 'sleep';
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
  for (const [key, el] of Object.entries(scenes)) el.classList.toggle('on', key === name);
  shownScene = name;
  sceneShownAt = Date.now();
  placePanel();
  if (expanded) renderPanel(); // the hover region follows the panel
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

function render() {
  const now = Date.now();
  const waiting = data.sessions.filter((s) => s.state === 'permission');
  const waitMs = waiting.length ? now - Math.min(...waiting.map((s) => s.since)) : 0;
  const urgent = data.state === 'permission' && waitMs >= URGENT_MS;
  // background tasks keep him up: they will wake a session when they finish
  const idleMs =
    data.state === 'ready' && data.sessions.length && !data.sessions.some(activeBg)
      ? now - Math.max(bootedAt, ...data.sessions.map((s) => s.since))
      : 0;
  const sleepy = idleMs >= SLEEPY_MS;
  if (sleepy && !bedtime) startBedtime();
  else if (!sleepy && bedtime && bedtime !== 'waking') wake();
  widget.className = [
    STATE_CLASS[data.state] || 'state-off',
    urgent && 'urgent',
    sleepy && 'sleepy',
    bedtime === 'asleep' && 'asleep',
    idleNow() && cfg.dimIdle && 'dim',
    !expanded && 'collapsed',
  ]
    .filter(Boolean)
    .join(' ');
  const active = ACTIVE_LAMP[data.state] || 'green';
  for (const [name, el] of Object.entries(lamps)) {
    el.classList.toggle('active', name === active);
  }
  updateScene();
  const finished = data.sessions.filter((s) => s.state === 'ready' && s.unread).length;
  badge.hidden = finished === 0;
  badge.textContent = finished > 1 ? String(finished) : '';
  renderPanel();
  // the open panel lists every wait, and sits where the chip would be
  chip.hidden = data.state !== 'permission' || panel.classList.contains('open');
  if (!chip.hidden) chip.textContent = fmtDur(waitMs);
}

// ---------------------------------------------------------------- reactions

// One-shot keyframe animations on the Clawd box; the class comes off when the
// animation ends so the next one can play.
const REACTION_CLASS = { done: 'hop', flinch: 'flinch' };
const ONE_SHOTS = new Set(['hop', 'flinch', 'startle']);

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
  if (cls && !clawdEl.classList.contains('grabbed')) oneShot(cls);
});

// ------------------------------------------------------------------ bedtime

// After SLEEPY_MS of green, Clawd walks off the widget, comes back half a
// second later with a nightcap, a teddy and a blanket, sits down on his folded
// legs, hugs the teddy and throws the blanket over his lap. Any change of
// state startles him awake: he jumps up and the props tumble off the bottom
// of the screen.
// phases: null | leaving | away | returning | lying | asleep | waking
// ('lying' is the settling down, before the z's)
const BED_WALK_MS = 1700; // matches the .bed-leaving / .bed-returning transitions
const BED_AWAY_MS = 500;
const BED_TUCK_MS = 1500; // settling down until the z's start
const BED_WAKE_MS = 1000; // the jump and the props' fall

let bedtime = null;
let bedTimers = [];

function bedLater(ms, fn) {
  bedTimers.push(setTimeout(fn, ms));
}

function clearBedTimers() {
  for (const t of bedTimers) clearTimeout(t);
  bedTimers = [];
}

function setBedPhase(phase, cls) {
  bedtime = phase;
  clawdEl.classList.remove('bed-leaving', 'bed-away', 'bed-returning');
  if (cls) clawdEl.classList.add(cls);
  updateScene();
}

function startBedtime() {
  clearBedTimers();
  setBedPhase('leaving', 'bed-leaving');
  bedLater(BED_WALK_MS, () => {
    setBedPhase('away', 'bed-away');
    bedLater(BED_AWAY_MS, () => {
      setBedPhase('returning', 'bed-returning');
      bedLater(BED_WALK_MS, () => {
        setBedPhase('lying', null);
        bedLater(BED_TUCK_MS, () => {
          bedtime = 'asleep';
          render();
        });
      });
    });
  });
}

function wake() {
  const hadProps = bedtime === 'returning' || bedtime === 'lying' || bedtime === 'asleep';
  clearBedTimers();
  setBedPhase('waking', null);
  oneShot('startle');
  if (hadProps) {
    props.classList.remove('drop');
    void props.offsetWidth;
    props.classList.add('drop');
  }
  bedLater(BED_WAKE_MS, () => {
    bedtime = null;
    props.classList.remove('drop');
    render();
  });
}

// Petting is a wiggle of alternating tilt classes rather than a keyframe loop,
// so letting go puts him straight back from whichever side he is on.
let wiggleTimer = null;
let wiggleSide = 1;
let happyTimer = null;

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

// ------------------------------------------------------------- grabbing Clawd

let grabStart = null; // pointerdown position, before the drag threshold
let grabbing = false;
let petTimer = null;
let petting = false;

clawdEl.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  grabStart = { id: e.pointerId, x: e.clientX, y: e.clientY };
  window.stoplight.clawdWarm(); // pre-load the overlay window
  try {
    clawdEl.setPointerCapture(e.pointerId);
  } catch {}
  clearTimeout(petTimer);
  petTimer = setTimeout(() => {
    petTimer = null;
    if (grabStart && !grabbing) {
      petting = true;
      startWiggle();
    }
  }, PET_HOLD_MS);
});

clawdEl.addEventListener('pointermove', (e) => {
  if (!grabStart || grabbing || e.pointerId !== grabStart.id) return;
  if (Math.hypot(e.clientX - grabStart.x, e.clientY - grabStart.y) < 4) return;
  grabbing = true;
  clearTimeout(petTimer);
  petTimer = null;
  if (petting) {
    petting = false;
    stopWiggle(0);
  }
  // the widget's Clawd stays put until main says the overlay has taken over
  // ('clawd:away'), so he never blinks out before the overlay can draw him
  window.stoplight.clawdGrab(clawdRect());
});

function endGrab(e) {
  if (!grabStart || e.pointerId !== grabStart.id) return;
  grabStart = null;
  const quickTap = petTimer !== null;
  clearTimeout(petTimer);
  petTimer = null;
  if (grabbing) {
    grabbing = false;
    window.stoplight.clawdRelease();
    return;
  }
  if (petting) {
    petting = false;
    stopWiggle();
  } else if (quickTap) {
    startWiggle();
    setTimeout(() => {
      if (!petting) stopWiggle();
    }, TAP_WIGGLE_MS);
  }
}
clawdEl.addEventListener('pointerup', endGrab);
clawdEl.addEventListener('pointercancel', endGrab);

window.stoplight.onClawdAway(() => clawdEl.classList.add('grabbed'));
window.stoplight.onClawdRestore(() => clawdEl.classList.remove('grabbed'));

// --------------------------------------------------------------------- hover

// Hover comes from the main process, which polls the cursor against the
// window bounds — immune to per-pixel hit-testing and resize transients.
// Collapse is still debounced briefly so a grazing exit doesn't flicker.
let leaveTimer = null;
window.stoplight.onHover((over) => {
  clearTimeout(leaveTimer);
  if (over) {
    if (!expanded) {
      expanded = true;
      render();
    }
  } else {
    leaveTimer = setTimeout(() => {
      expanded = false;
      render();
    }, 120);
  }
});

// keep the wait timer / row durations / dozing fresh
setInterval(render, 2000);

window.stoplight.onState((d) => {
  data = d;
  render();
});
window.stoplight.onUsage((u) => {
  usage = u;
  render();
});
window.stoplight.onConfig((c) => {
  cfg = c;
  root.style.zoom = cfg.zoom;
  setPixelGrid();
  render();
});
render();
