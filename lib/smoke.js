// A scripted run of the real app, for checking a build with nobody at it:
// start it with CLAWD_SMOKE=<folder> and it plays a short session at itself
// over its own hook port, opens and closes the tray, rests the pointer on a
// tile, moves the lamp to the opposite corner of the screen, saves a picture
// and the page's own account of each step into that folder, writes
// report.json, and exits 0 if every check held (1 if not). main.js hands over
// the few things it needs.
//
// Point CLAWD_DATA_DIR and CLAUDE_CONFIG_DIR at scratch folders first, so the
// run touches neither the user's widget nor their Claude Code settings.
const fs = require('fs');
const http = require('http');
const path = require('path');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const PREVIEW = '3-needs-open'; // the step also saved small, as preview.jpg

// the colours the page is drawn in (renderer/style.css)
const INK = [14, 14, 15];
const TRAY = [201, 201, 204];
const RED = [255, 69, 58];
const GREEN = [48, 209, 88];

// what the page is showing, in its own words
const DESCRIBE = `(() => {
  const text = (sel) => [...document.querySelectorAll(sel)].filter((el) => el.offsetParent).map((el) => el.textContent.trim());
  const space = document.getElementById('space');
  const lamp = document.getElementById('lamp').getBoundingClientRect();
  const tray = document.getElementById('tray');
  return {
    classes: space.className.split(/\\s+/).filter(Boolean).sort(),
    rows: text('.row'),
    legend: text('.lrow'),
    pill: text('#pill'),
    wait: text('#wait'),
    badge: document.getElementById('badge').hidden ? null : document.getElementById('badge').textContent,
    scene: (document.querySelector('.scene.on') || {}).id || null,
    trayOpacity: Number(getComputedStyle(tray).opacity),
    hot: space.dataset.hot || null,
    cardScale: new DOMMatrix(getComputedStyle(document.getElementById('tile-card')).transform).a,
    stillness: matchMedia('(prefers-reduced-motion: reduce)').matches,
    lamp: { x: Math.round(lamp.x + lamp.width / 2), y: Math.round(lamp.y + lamp.height / 2) },
    inner: { w: window.innerWidth, h: window.innerHeight },
    font: document.fonts.check('12px Inter'),
    zoom: document.getElementById('root').style.zoom,
  };
})()`;

module.exports = async function smoke(api) {
  const dir = api.dir;
  fs.mkdirSync(dir, { recursive: true });
  const steps = [];
  const failures = [];
  const check = (step, what, ok, got) => {
    if (!ok) failures.push(`${step}: ${what}${got === undefined ? '' : ` (got ${JSON.stringify(got)})`}`);
  };

  const post = (route, payload) =>
    new Promise((resolve, reject) => {
      const body = Buffer.from(JSON.stringify(payload));
      const req = http.request(
        {
          host: '127.0.0.1',
          port: api.port,
          path: `/claude-stoplight/${route}`,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        }
      );
      req.on('error', reject);
      req.end(body);
    });

  // The picture of a step, and a way to read single pixels out of it:
  // px(x, y) is [r, g, b, a] at a point given in window coordinates.
  const snap = async (name) => {
    const page = await api.win.webContents.executeJavaScript(DESCRIBE);
    let px = () => null;
    try {
      const image = await api.win.webContents.capturePage();
      fs.writeFileSync(path.join(dir, `${name}.png`), image.toPNG());
      if (name === PREVIEW) fs.writeFileSync(path.join(dir, 'preview.jpg'), image.toJPEG(70));
      const size = image.getSize();
      const bitmap = image.toBitmap(); // BGRA
      const k = size.width / page.inner.w;
      px = (x, y) => {
        const at = (Math.min(size.height - 1, Math.round(y * k)) * size.width + Math.min(size.width - 1, Math.round(x * k))) * 4;
        return [bitmap[at + 2], bitmap[at + 1], bitmap[at], bitmap[at + 3]];
      };
    } catch (err) {
      failures.push(`${name}: no picture (${err.message})`);
    }
    const step = { name, page, main: api.state(), px };
    steps.push(step);
    return step;
  };

  // is the pixel there this colour (and opaque), near enough?
  const painted = (step, what, x, y, rgb) => {
    const got = step.px(x, y);
    const ok = Boolean(got) && got[3] > 250 && rgb.every((c, i) => Math.abs(c - got[i]) <= 8);
    check(step.name, `${what} is painted ${JSON.stringify(rgb)} at ${x},${y}`, ok, got);
  };
  const clear = (step, what, x, y) => {
    const got = step.px(x, y);
    check(step.name, `${what} is transparent at ${x},${y}`, Boolean(got) && got[3] === 0, got);
  };

  const has = (list, cls) => list.includes(cls);

  try {
    if (api.win.webContents.isLoading()) {
      await new Promise((resolve) => api.win.webContents.once('did-finish-load', resolve));
    }
    api.setHover(false);
    await wait(600);

    // 1. nothing running
    let s = await snap('1-off');
    check(s.name, 'the lamp is unlit', has(s.page.classes, 'state-off'), s.page.classes);
    check(s.name, 'the bundled font loaded', s.page.font === true, s.page.font);
    check(s.name, 'the page fills the window', s.page.inner.w === s.main.bounds.width && s.page.inner.h === s.main.bounds.height, s.page.inner);
    check(s.name, 'the window is square', s.main.bounds.width === s.main.winSize && s.main.bounds.height === s.main.winSize, s.main.bounds);
    // Pixels are read at 100% size with the lamp bottom-right: its centre is
    // then at 266,266 in the 300 px window.
    const full = s.main.winSize === 300 && s.main.corner === 'br';
    if (full) {
      clear(s, 'the window away from the lamp', 150, 150);
      clear(s, 'the window\'s far corner', 8, 8);
      painted(s, 'the lamp\'s bezel', 266, 250, INK);
    }

    // 2. a session starts work, and Claude Code's status line reports usage
    const a = { session_id: 'smoke-a', cwd: path.join('C:', 'dev', 'alpha') };
    check('2-working', 'SessionStart accepted', (await post('event/SessionStart', a)) === 200);
    await post('event/UserPromptSubmit', a);
    await post('event/PreToolUse', Object.assign({ tool_name: 'Edit', tool_input: { file_path: 'C:/dev/alpha/main.js' } }, a));
    const soon = Math.floor(Date.now() / 1000);
    const status = await post('statusline', {
      session_id: 'smoke-a',
      rate_limits: {
        five_hour: { used_percentage: 41.6, resets_at: soon + 2 * 3600 },
        seven_day: { used_percentage: 61.2, resets_at: soon + 3 * 86400 },
      },
    });
    check('2-working', 'the status line route answers 204', status === 204, status);
    api.setHover(true);
    await wait(1800); // a pose is held a moment before the next replaces it
    s = await snap('2-working-open');
    check(s.name, 'the lamp is amber', has(s.page.classes, 'state-working'), s.page.classes);
    check(s.name, 'the tray is open', has(s.page.classes, 'open') && s.page.trayOpacity === 1, s.page.trayOpacity);
    check(s.name, 'one session row', s.page.rows.length === 1 && /alpha/.test(s.page.rows[0]) && /Edit: main\.js/.test(s.page.rows[0]), s.page.rows);
    check(s.name, 'the pill says Working', /^Working/.test(s.page.pill[0] || ''), s.page.pill);
    check(s.name, 'two usage figures from the status line', s.page.legend.length === 2 && /42%/.test(s.page.legend[0]) && /61%/.test(s.page.legend[1]), s.page.legend);
    check(s.name, 'he is typing', s.page.scene === 'scene-type', s.page.scene);
    check(s.name, 'main knows the tray is open', s.main.live.open === true, s.main.live);

    // 3. a second session needs permission
    const b = { session_id: 'smoke-b', cwd: path.join('C:', 'dev', 'beta') };
    await post('event/SessionStart', b);
    await post('event/UserPromptSubmit', b);
    await post('event/PermissionRequest', Object.assign({ tool_name: 'Bash', tool_input: { command: 'npm publish' } }, b));
    await wait(500);
    s = await snap('3-needs-open');
    check(s.name, 'the lamp is red', has(s.page.classes, 'state-permission'), s.page.classes);
    check(s.name, 'two rows, the waiting one first', s.page.rows.length === 2 && /beta/.test(s.page.rows[0]) && /needs you · Bash: npm publish/.test(s.page.rows[0]), s.page.rows);
    check(s.name, 'the pill says Needs you', /^Needs you/.test(s.page.pill[0] || ''), s.page.pill);
    if (full) {
      clear(s, 'the corner the tray\'s arc cuts off', 8, 8);
      painted(s, 'the lamp\'s ring', 266, 245.5, RED);
      painted(s, 'the usage tile', 283, 17, INK);
      painted(s, 'the sessions card', 273, 228, INK);
      painted(s, 'the tray between its tiles', 291, 153, TRAY);
      painted(s, 'the status pill', 100, 255, INK);
    }
    check(s.name, 'no tile has swelled with the pointer on none', s.page.hot === null && s.page.cardScale === 1, s.page.cardScale);

    // the pointer comes to rest on the sessions card, which swells a little
    // (and holds still where Windows has animations switched off)
    api.setHot('card');
    await wait(600);
    s = await snap('3-needs-on-card');
    check(s.name, 'the page knows the pointer is on the card', s.page.hot === 'card', s.page.hot);
    const swelled = s.page.stillness ? s.page.cardScale === 1 : s.page.cardScale > 1.01 && s.page.cardScale < 1.05;
    check(s.name, s.page.stillness ? 'the card holds still under Reduce Motion' : 'the card has swelled a little', swelled, s.page.cardScale);
    if (full) painted(s, 'the tray between the swelled card and its edge', 292, 153, TRAY);
    api.setHot(null);

    // 4. the pointer leaves
    api.setHover(false);
    await wait(700);
    s = await snap('4-needs-rest');
    check(s.name, 'the tray has folded', !has(s.page.classes, 'open') && s.page.trayOpacity === 0, s.page.trayOpacity);
    check(s.name, 'the wait shows beside the lamp', s.page.wait.length === 1, s.page.wait);
    check(s.name, 'main knows how far the wait pill reaches', s.main.live.open === false && s.main.live.reach > 0, s.main.live);
    if (full) {
      clear(s, 'where the tray was', 150, 150);
      painted(s, 'the lamp', 266, 266, RED);
      painted(s, 'the wait pill', 236, 252, INK);
    }

    // 5. the permission is granted, both turns end
    await post('event/PostToolUse', Object.assign({ tool_name: 'Bash' }, b));
    await wait(2200); // past the window in which a tool event counts as a straggler
    await post('event/Stop', a);
    await post('event/Stop', b);
    await wait(500);
    s = await snap('5-finished-rest');
    check(s.name, 'the lamp is green', has(s.page.classes, 'state-ready'), s.page.classes);
    check(s.name, 'two finished turns on the badge', s.page.badge === '2', s.page.badge);
    if (full) painted(s, 'the lamp', 266, 266, GREEN);

    // 6. dragged to the opposite corner of the screen: the tray turns round
    const before = s.main;
    const area = api.workArea();
    api.moveTo({ x: area.x + 40, y: area.y + 30 });
    await wait(500);
    api.setHover(true);
    await wait(900);
    s = await snap('6-top-left-open');
    check(s.name, 'the lamp started bottom-right', before.corner === 'br', before.corner);
    check(s.name, 'the corner is now top-left', s.main.corner === 'tl' && has(s.page.classes, 'fx') && has(s.page.classes, 'fy'), s.main.corner);
    check(s.name, 'the lamp is in the window\'s top-left', s.page.lamp.x < s.page.inner.w / 2 && s.page.lamp.y < s.page.inner.h / 2, s.page.lamp);
    check(s.name, 'the window is on screen', s.main.bounds.x >= area.x && s.main.bounds.y >= area.y, s.main.bounds);
    check(s.name, 'the lamp is remembered', Boolean(s.main.lamp) && s.main.lamp.x < area.x + area.width / 2, s.main.lamp);

    // 7. both sessions end
    api.setHover(false);
    await post('event/SessionEnd', a);
    await post('event/SessionEnd', b);
    await wait(600);
    s = await snap('7-off');
    check(s.name, 'the lamp is unlit again', has(s.page.classes, 'state-off') && s.page.rows.length === 0, s.page.classes);
    check(s.name, 'the usage figures are kept', s.main.usage.bars.length === 2, s.main.usage.bars);
  } catch (err) {
    failures.push(`the run stopped: ${(err && err.stack) || err}`);
  }

  // the status line install tries its wrapper first, which can outlast the script
  try {
    await Promise.race([api.settled(), wait(40000)]);
  } catch {}
  for (const step of steps) delete step.px;
  const report = { ok: failures.length === 0, failures, extra: api.extra(), steps };
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
  api.quit(report.ok ? 0 : 1);
};
