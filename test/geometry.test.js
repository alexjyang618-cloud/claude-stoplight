const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../renderer/geometry.js');

const numbers = (d) => d.match(/-?\d+(\.\d+)?/g).map(Number);

test('the sizes the page and the main process both build on', () => {
  assert.equal(G.SIZE, 291);
  assert.equal(G.D, 263);
  assert.equal(G.WINDOW, 300);
  assert.equal(G.LAMP_INSET, 34);
  assert.equal(G.trayRadius, 263);
  // style.css sizes #root and #space with these
  const css = require('fs').readFileSync(require('path').join(__dirname, '..', 'renderer', 'style.css'), 'utf8');
  assert.match(css, new RegExp(`#root \\{[^}]*width: ${G.WINDOW}px;[^}]*height: ${G.WINDOW}px;`));
  assert.match(css, new RegExp(`#space \\{[^}]*width: ${G.SIZE}px;[^}]*height: ${G.SIZE}px;`));
});

test('the tiles are closed shapes inside the tray', () => {
  for (const d of [G.usagePath, G.cardPath]) {
    assert.ok(d.startsWith('M') && d.endsWith('Z'));
    assert.ok(!/NaN|Infinity|undefined/.test(d));
    for (const n of numbers(d)) assert.ok(n >= 0 && n <= G.SIZE, `${n} lies outside the tray`);
  }
});

test('three gauges, outer first, each ending level with its legend row', () => {
  assert.equal(G.gauges.length, 3);
  const radii = G.gauges.map((g) => Number(/A([\d.]+) /.exec(g.d)[1]));
  assert.ok(radii[0] > radii[1] && radii[1] > radii[2]);
  for (const g of G.gauges) {
    const n = numbers(g.d);
    assert.equal(n[n.length - 1], g.rowY); // the gauge's last point is at its row's height
    assert.ok(!/NaN/.test(g.d));
  }
  // the outer gauge ends highest, so the legend reads 5-hour, week, model downwards
  assert.ok(G.gauges[0].rowY < G.gauges[1].rowY && G.gauges[1].rowY < G.gauges[2].rowY);
  // rows sit clear of each other and inside the legend block
  assert.ok(G.gauges[1].rowY - G.gauges[0].rowY >= G.legend.rowH);
  assert.ok(G.gauges[2].rowY + G.legend.rowH / 2 < G.card.top);
});

test('the card narrows as it climbs away from the lamp', () => {
  let last = -Infinity;
  for (let y = G.card.bottom; y >= G.card.top; y -= 5) {
    const limit = G.cardLimit(y);
    assert.ok(limit >= last, 'the limit must move towards the lamp');
    assert.ok(limit < G.card.textEdge);
    last = limit;
  }
  assert.equal(G.cardLimit(-1000), G.D); // far above the card there is no room at all
});

test('the pill and the lamp share a row beside the card', () => {
  assert.equal(G.pill.top, G.D - G.LAMP_R);
  assert.equal(G.pill.height, 2 * G.LAMP_R);
  assert.equal(G.pill.left + G.pill.width + G.GAP, G.D - G.LAMP_R);
  assert.equal(G.card.bottom + G.GAP, G.pill.top);
});

test('hit-testing the opened tray: a quarter-disc with the lamp\'s corner squared off', () => {
  assert.ok(G.insideTray(0, 0, 0)); // the lamp
  assert.ok(G.insideTray(100, 100, 0));
  assert.ok(G.insideTray(-20, 200, 0)); // the strip beside the lamp
  assert.ok(G.insideTray(200, -20, 0));
  assert.ok(G.insideTray(G.trayRadius, 0, 0));
  assert.ok(!G.insideTray(-40, 10, 3)); // past the screen-side edge
  assert.ok(!G.insideTray(250, 250, 3)); // the corner the arc cuts off
  assert.ok(!G.insideTray(G.trayRadius + 10, 0, 3));
  // the pad lets the pointer stray a little
  assert.ok(!G.insideTray(G.trayRadius + 2, 5, 0));
  assert.ok(G.insideTray(G.trayRadius + 2, 5, 3));
});

test('hit-testing at rest: the lamp, and the wait pill when there is one', () => {
  assert.ok(G.insideRest(0, 0, 0, 3));
  assert.ok(G.insideRest(G.DOT_R, -G.DOT_R, 0, 3));
  assert.ok(!G.insideRest(60, 0, 0, 3));
  assert.ok(G.insideRest(60, 0, 76, 3));
  assert.ok(!G.insideRest(90, 0, 76, 3));
  assert.ok(!G.insideRest(0, 40, 76, 3));
  assert.ok(!G.insideRest(-30, 0, 76, 3));
});
