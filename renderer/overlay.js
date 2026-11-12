// Clawd escapade: hang from the cursor (pendulum), fall when released, walk
// home along the bottom of the desktop, hop back into the widget. A "visit"
// runs the other way: hop down, run to a session's terminal window, knock,
// run back. While he is out here he can be caught again — the widget window
// owns the first drag, but any later grab happens on this window, which main
// makes clickable only while the cursor is over him ('clawd:catchable').
//
// Geometry (hang sprite viewBox 150x120, at u px per unit):
//   pivot (his left arm, lifted over his head, at the cursor) = (30, 40), feet = y 118
// Walk sprite viewBox 100x100 matches the widget's Clawd box exactly, so
// putting its top-left at `home` reproduces the widget Clawd 1:1.

// ---------------------------------------------------------------- rigid body

// Clawd is one rigid body swinging about the claw. Everything here is in hang
// sprite units; multiply by `u` for pixels.
const PIV = { x: 30, y: 40 }; // gripping arm = pivot, glued to the cursor
const COM = { x: 62, y: 84 }; // centre of mass (body + legs)
const FEET = { x: 62, y: 120 };
// hang sprite top-left relative to the widget's Clawd box while he stands
// upright (hang body 32..92 x 60..102 over widget body 22..82 x 40..82)
const HANG_OFF = { x: -10, y: -20 };
const WALK_COM_X = 52; // body centre in the walk sprite
const WALK_COM_Y = 61;

const D = Math.hypot(COM.x - PIV.x, COM.y - PIV.y); // pivot -> CoM distance
// angle of that vector in the unrotated sprite, measured from straight down
// (positive = right). Rotating the sprite by PHI0 hangs the CoM under the claw.
const PHI0 = Math.atan2(COM.x - PIV.x, COM.y - PIV.y);
// compound pendulum: the equivalent simple-pendulum length is d + k²/d, with k
// the radius of gyration about the CoM (his body is roughly a 60x64 box)
const K2 = (60 * 60 + 64 * 64) / 12;
const L = D + K2 / D;

// ---------------------------------------------------------------- world

// One sprite unit is one millimetre — Clawd is a 10 cm creature under real
// gravity. Pixel values scale with u, so the widget size never changes the feel.
const G = 9800; // units/s²
const DAMP_LIN = 0.8; // pivot friction, 1/s
const DAMP_QUAD = 0.2; // air drag, 1/rad — tames violent spins, leaves gentle swings alone
const FOLLOW = 120; // claw -> cursor tracking stiffness, rad/s (critically damped)
const AIR_X = 1.2; // horizontal drag while falling, 1/s
const RIGHT_K = 60; // "land on your feet" righting torque while falling
const RIGHT_C = 14;
const BOUNCE_MIN = 500; // units/s — slower landings don't bounce
const BOUNCE_REST = 0.3;
const WALL_REST = 0.4;
const SPEED_CAP = 3600; // units/s
const H = 1 / 480; // physics substep, s

const WALK_SPEED = 240; // units/s, strolling home after a fall
const RUN_SPEED = 820; // units/s, visiting a terminal
const KNOCKS = 3;
const CATCH_LAG = 0.035; // s of cursor-sample staleness the catch box allows for

const stage = document.getElementById('stage');
const hangEl = document.getElementById('hang');
const walkEl = document.getElementById('walk');

let P = null; // params from main: origin, size, floor, home, unit, state, visit
let u = 1;
let phase = 'idle'; // idle | drag | fall | walk | jump
let raf = 0;
let lastT = 0;

let cursor = null; // latest cursor position, display-local px
let pivot = { x: 0, y: 0 }; // claw, px (drag)
let pivotVel = { x: 0, y: 0 };
let theta = 0; // angle of pivot -> CoM from straight down, rad (positive = right)
let omega = 0; // rad/s
let com = { x: 0, y: 0 }; // centre of mass, px (fall)
let vel = { x: 0, y: 0 };
let walkX = 0; // walk sprite top-left, px (walk / jump)
let walkY = 0;
let walkDir = 1;
let travel = null; // { targetX, speed, then }
let jump = null; // { t0, y0, y1, dur, arc, then }
let catchable = false; // cursor is over Clawd and he may be grabbed
let holdingId = null; // pointer id of a catch in progress on this window

function localPoint(pt) {
  return {
    x: Math.min(Math.max(pt.x - P.origin.x, 0), P.size.w),
    y: Math.min(Math.max(pt.y - P.origin.y, 0), P.size.h),
  };
}

function floorLocal() {
  return P.floor - P.origin.y;
}

function homeLocal() {
  return { x: P.home.x - P.origin.x, y: P.home.y - P.origin.y };
}

function wrapAngle(a) {
  return a - 2 * Math.PI * Math.round(a / (2 * Math.PI));
}

// rotate a sprite-space vector by a CSS rotation (clockwise-positive on screen)
function rot(x, y, r) {
  const c = Math.cos(r);
  const s = Math.sin(r);
  return { x: x * c - y * s, y: x * s + y * c };
}

// the CSS rotate() that puts the CoM at angle theta below the claw
function rotation() {
  return PHI0 - theta;
}

// where the claw sits when he stands upright with the walk sprite at (walkX, walkY)
function clawFromWalk() {
  return { x: walkX + (HANG_OFF.x + PIV.x) * u, y: walkY + (HANG_OFF.y + PIV.y) * u };
}

// px,py = where the claw is on screen
function renderHangAt(px, py) {
  hangEl.style.transform =
    `translate(${px - PIV.x * u}px, ${py - PIV.y * u}px) rotate(${rotation()}rad)`;
}

function renderFall() {
  const v = rot((COM.x - PIV.x) * u, (COM.y - PIV.y) * u, rotation());
  renderHangAt(com.x - v.x, com.y - v.y);
}

// upright he is drawn on whole device pixels, so his pixel art stays crisp
// and every part of him moves by the same amount
function snap(v) {
  const r = window.devicePixelRatio || 1;
  return Math.round(v * r) / r;
}

function renderWalk() {
  walkEl.style.transform = `translate(${snap(walkX)}px, ${snap(walkY)}px)`;
}

function showHang() {
  walkEl.hidden = true;
  walkEl.classList.remove('walking', 'running');
  hangEl.hidden = false;
}

function showWalk() {
  hangEl.hidden = true;
  walkEl.hidden = false;
}

// ---------------------------------------------------------------- lifecycle

window.stoplight.onClawdBegin((p) => {
  P = p;
  u = p.unit;
  stage.className = `state-${p.state}`;
  hangEl.style.width = `${150 * u}px`;
  hangEl.style.height = `${120 * u}px`;
  hangEl.style.transformOrigin = `${PIV.x * u}px ${PIV.y * u}px`;
  walkEl.style.width = `${100 * u}px`;
  walkEl.style.height = `${100 * u}px`;
  walkEl.style.setProperty('--dp', `${1 / (u * (window.devicePixelRatio || 1))}px`);
  cursor = null;
  travel = null;
  jump = null;
  holdingId = null;
  stage.classList.remove('holding');
  setCatchable(false);
  const h = homeLocal();
  if (p.visit) {
    // standing at home: hop down to the floor, run to the window, knock, run back
    walkX = h.x;
    walkY = h.y;
    showWalk();
    renderWalk();
    const target = p.visit.x - P.origin.x - WALK_COM_X * u;
    startJump(walkY, floorLocal() - 100 * u, 380, 16 * u, () => startTravel(target, RUN_SPEED, knock));
  } else {
    // he starts standing exactly where the widget draws him; the claw then gets
    // pulled to the cursor and gravity swings him down into his hanging pose
    pivot = { x: h.x + (HANG_OFF.x + PIV.x) * u, y: h.y + (HANG_OFF.y + PIV.y) * u };
    pivotVel = { x: 0, y: 0 };
    theta = PHI0;
    omega = 0;
    showHang();
    renderHangAt(pivot.x, pivot.y);
    phase = 'drag';
  }
  lastT = performance.now();
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(loop);
});

window.stoplight.onClawdCursor((pt) => {
  if (P) cursor = localPoint(pt);
});

window.stoplight.onClawdReleased(release);

function release() {
  if (phase !== 'drag') return;
  // the body flies off with the claw's velocity plus its own swing velocity
  const s = Math.sin(theta);
  const c = Math.cos(theta);
  const d = D * u;
  com = { x: pivot.x + d * s, y: pivot.y + d * c };
  vel = { x: pivotVel.x + d * omega * c, y: pivotVel.y - d * omega * s };
  const mag = Math.hypot(vel.x, vel.y);
  const cap = SPEED_CAP * u;
  if (mag > cap) {
    vel.x *= cap / mag;
    vel.y *= cap / mag;
  }
  phase = 'fall';
}

function finish() {
  phase = 'idle';
  hangEl.hidden = true;
  walkEl.hidden = true;
  setCatchable(false);
  cancelAnimationFrame(raf);
  window.stoplight.clawdDone();
}

function loop(now) {
  const dt = Math.min((now - lastT) / 1000, 0.05);
  lastT = now;
  if (phase === 'drag' || phase === 'fall') {
    // fixed substeps keep the stiff claw spring and fast spins accurate
    const n = Math.max(1, Math.ceil(dt / H));
    const h = dt / n;
    for (let i = 0; i < n && (phase === 'drag' || phase === 'fall'); i++) {
      if (phase === 'drag') stepDrag(h);
      else stepFall(h);
    }
    if (phase === 'drag') renderHangAt(pivot.x, pivot.y);
    else if (phase === 'fall') renderFall();
  } else if (phase === 'walk') stepWalk(dt);
  else if (phase === 'jump') stepJump(now);
  updateCatchable();
  if (phase !== 'idle') raf = requestAnimationFrame(loop);
}

// ---------------------------------------------------------------- drag / fall

function stepDrag(h) {
  // The claw tracks the cursor as a stiff, critically damped spring. That
  // smooths the 60 Hz cursor samples and, more importantly, gives the pivot a
  // well-defined acceleration to drive the pendulum with.
  let ax = 0;
  let ay = 0;
  if (cursor) {
    ax = FOLLOW * FOLLOW * (cursor.x - pivot.x) - 2 * FOLLOW * pivotVel.x;
    ay = FOLLOW * FOLLOW * (cursor.y - pivot.y) - 2 * FOLLOW * pivotVel.y;
    pivotVel.x += ax * h;
    pivotVel.y += ay * h;
    pivot.x += pivotVel.x * h;
    pivot.y += pivotVel.y * h;
  }
  stepPendulum(h, ax, ay);
}

// Pendulum hanging from an accelerating pivot: in the claw's frame gravity
// becomes (-ax, g - ay). Move sideways and he lags, then overshoots; yank him
// up and he swings stiffer; drop the cursor faster than he falls and he floats
// (or flips over the top — a rigid arm allows full rotations).
function stepPendulum(h, ax, ay) {
  const s = Math.sin(theta);
  const c = Math.cos(theta);
  let alpha = -((G * u - ay) * s + ax * c) / (L * u);
  alpha -= DAMP_LIN * omega + DAMP_QUAD * omega * Math.abs(omega);
  omega += alpha * h;
  theta = wrapAngle(theta + omega * h);
}

function stepFall(h) {
  vel.y += G * u * h;
  vel.x *= Math.max(0, 1 - AIR_X * h);
  com.x += vel.x * h;
  com.y += vel.y * h;
  // side walls
  const m = 40 * u;
  if (com.x < m) {
    com.x = m;
    vel.x = Math.abs(vel.x) * WALL_REST;
  } else if (com.x > P.size.w - m) {
    com.x = P.size.w - m;
    vel.x = -Math.abs(vel.x) * WALL_REST;
  }
  // cartoon licence: a free body would keep whatever spin it had, but he
  // rights himself in the air so he can land on his feet
  omega += (-RIGHT_K * wrapAngle(theta - PHI0) - RIGHT_C * omega) * h;
  theta = wrapAngle(theta + omega * h);
  // floor contact is at his feet, wherever they are in the current pose
  const f = rot((FEET.x - COM.x) * u, (FEET.y - COM.y) * u, rotation());
  const feetY = com.y + f.y;
  const fl = floorLocal();
  if (feetY >= fl) {
    com.y -= feetY - fl;
    if (vel.y > BOUNCE_MIN * u) {
      vel.y *= -BOUNCE_REST;
      vel.x *= 0.6;
    } else {
      // grounded: skid to a stop, finish standing up, then walk
      vel.y = 0;
      vel.x *= Math.max(0, 1 - 8 * h);
      if (Math.abs(wrapAngle(theta - PHI0)) < 0.05 && Math.abs(omega) < 1) startWalkHome();
    }
  }
}

function startWalkHome() {
  walkX = com.x - WALK_COM_X * u;
  walkY = floorLocal() - 100 * u; // walk feet at y=100 of the walk sprite
  showWalk();
  startTravel(homeLocal().x, WALK_SPEED, jumpHome);
}

// ---------------------------------------------------------------- walk / jump

function startTravel(targetX, speed, then) {
  phase = 'walk';
  travel = { targetX, speed, then };
  walkDir = targetX >= walkX ? 1 : -1;
  walkEl.classList.add('walking');
  walkEl.classList.toggle('running', speed > WALK_SPEED);
  renderWalk();
}

function stepWalk(dt) {
  const { targetX, speed, then } = travel;
  walkX += walkDir * speed * u * dt;
  if ((walkDir > 0 && walkX >= targetX) || (walkDir < 0 && walkX <= targetX)) {
    walkX = targetX;
    walkEl.classList.remove('walking', 'running');
    travel = null;
    renderWalk();
    then();
    return;
  }
  renderWalk();
}

// a smooth-step rise from y0 to y1 with a sine arc of `arc` px on top
function startJump(y0, y1, dur, arc, then) {
  phase = 'jump';
  jump = { t0: performance.now(), y0, y1, dur, arc, then };
}

function stepJump(now) {
  const { t0, y0, y1, dur, arc, then } = jump;
  const t = Math.min(1, (now - t0) / dur);
  const e = t * t * (3 - 2 * t);
  walkY = y0 + (y1 - y0) * e - Math.sin(Math.PI * t) * arc;
  renderWalk();
  if (t >= 1) {
    jump = null;
    then();
  }
}

function jumpHome() {
  const homeY = homeLocal().y;
  if (Math.abs(walkY - homeY) < 3) {
    finish();
    return;
  }
  const dur = Math.max(280, Math.min(700, Math.abs(walkY - homeY) * 2));
  startJump(walkY, homeY, dur, 30 * u, finish);
}

// three little hops at the window, then run home
function knock() {
  let left = KNOCKS;
  const hop = () => {
    if (left-- > 0) startJump(walkY, walkY, 230, 11 * u, hop);
    else startTravel(homeLocal().x, RUN_SPEED, jumpHome);
  };
  hop();
}

// ---------------------------------------------------------------- catching

function bodyCenter() {
  if (phase === 'fall') return com;
  return { x: walkX + WALK_COM_X * u, y: walkY + WALK_COM_Y * u };
}

function setCatchable(on) {
  if (on === catchable) return;
  catchable = on;
  stage.classList.toggle('catchable', on);
  window.stoplight.clawdCatchable(on);
}

// While he is loose (falling, walking, hopping) and the cursor is over him,
// main lets this window take the click. During a hold it must keep taking
// events regardless of where the cursor wanders.
function updateCatchable() {
  let on = holdingId !== null;
  if (!on && cursor && (phase === 'fall' || phase === 'walk' || phase === 'jump')) {
    // a generous box, stretched along his velocity while falling: the cursor
    // sample is a frame or two old and he covers tens of pixels per frame
    const c = bodyCenter();
    const pad = 14 * u;
    const ex = phase === 'fall' ? Math.abs(vel.x) * CATCH_LAG : 0;
    const ey = phase === 'fall' ? Math.abs(vel.y) * CATCH_LAG : 0;
    on =
      Math.abs(cursor.x - c.x) <= 34 * u + pad + ex &&
      Math.abs(cursor.y - c.y) <= 40 * u + pad + ey;
  }
  setCatchable(on);
}

// Snatch him out of whatever he is doing: the claw keeps its current position
// and velocity, and the follower spring pulls it to the cursor from there, so
// nothing jumps and the swing that follows is the real dynamic response.
function catchNow() {
  if (phase === 'fall') {
    const r = rotation();
    const q = rot((COM.x - PIV.x) * u, (COM.y - PIV.y) * u, r); // pivot -> CoM, world
    pivot = { x: com.x - q.x, y: com.y - q.y };
    // rigid body: v_claw = v_com + spin × (claw − com); the spin rate in CSS
    // (clockwise) terms is −omega, and claw − com = −q
    pivotVel = { x: vel.x - omega * q.y, y: vel.y + omega * q.x };
    // theta / omega carry over unchanged: he keeps his pose and his spin
  } else {
    // upright on the floor (or mid-hop): the claw is where the hang sprite's arm is
    pivot = clawFromWalk();
    pivotVel = { x: phase === 'walk' && travel ? walkDir * travel.speed * u : 0, y: 0 };
    theta = PHI0;
    omega = 0;
  }
  travel = null;
  jump = null;
  showHang();
  phase = 'drag';
  renderHangAt(pivot.x, pivot.y);
  window.stoplight.clawdCaught();
}

stage.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !catchable || holdingId !== null) return;
  holdingId = e.pointerId;
  try {
    stage.setPointerCapture(e.pointerId);
  } catch {}
  stage.classList.add('holding');
  cursor = { x: e.clientX, y: e.clientY };
  catchNow();
});

stage.addEventListener('pointermove', (e) => {
  // lower latency than the 60 Hz feed while this window owns the drag
  if (holdingId !== null && e.pointerId === holdingId) cursor = { x: e.clientX, y: e.clientY };
});

function endHold(e) {
  if (holdingId === null || e.pointerId !== holdingId) return;
  holdingId = null;
  stage.classList.remove('holding');
  release();
}
stage.addEventListener('pointerup', endHold);
stage.addEventListener('pointercancel', endHold);
