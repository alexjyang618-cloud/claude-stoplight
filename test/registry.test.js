const test = require('node:test');
const assert = require('node:assert/strict');
const registry = require('../lib/registry');

const SEC = 1000;
const MIN = 60 * SEC;
const T0 = Date.UTC(2026, 10, 24, 9, 0, 0);

// a record as main.js's readSessionRegistry builds it
const record = (extra) =>
  Object.assign(
    { id: 'b00822a4-0000-4000-8000-000000000000', pid: 29424, cwd: 'C:\\work', startedAt: T0 - 10 * MIN, pstart: T0 - 10 * MIN - 400, status: null, statusAt: null, waitingFor: null, name: null, nameSource: null },
    extra
  );

// a session as a hook event leaves it (setSession in main.js)
const heard = (state, lastEvent) => ({ state, since: lastEvent, lastEvent, turnStart: state === 'working' ? lastEvent : null });

test('a record with no status is discovered as ready, with no turn running', () => {
  const got = registry.discover(record(), T0);
  assert.equal(got.state, 'ready');
  assert.equal(got.turnStart, null);
  assert.equal(got.since, T0 - 10 * MIN); // since it started
  assert.equal(got.lastEvent, T0);
  assert.equal(got.wait, undefined);
});

test('an idle record is discovered as ready, since it went idle', () => {
  const got = registry.discover(record({ status: 'idle', statusAt: T0 - 3 * MIN }), T0);
  assert.deepEqual([got.state, got.since, got.turnStart], ['ready', T0 - 3 * MIN, null]);
});

test('only a status that says so is discovered as working', () => {
  for (const status of ['busy', 'shell', 'waiting', 'something-new']) {
    const got = registry.discover(record({ status, statusAt: T0 - 20 * SEC }), T0);
    assert.deepEqual([status, got.state, got.since, got.turnStart], [status, 'working', T0 - 20 * SEC, T0 - 20 * SEC]);
  }
  // a status with no time of its own counts from when the session started
  const untimed = registry.discover(record({ status: 'busy' }), T0);
  assert.deepEqual([untimed.state, untimed.since, untimed.turnStart], ['working', T0 - 10 * MIN, T0 - 10 * MIN]);
});

test('a record with no status is left alone until it is a few seconds old', () => {
  const started = (ago) => record({ startedAt: T0 - ago, pstart: T0 - ago - 400 });
  assert.deepEqual(registry.discover(started(0), T0), { wait: registry.SETTLE_MS });
  assert.deepEqual(registry.discover(started(1200), T0), { wait: registry.SETTLE_MS - 1200 });
  assert.deepEqual(registry.discover(started(registry.SETTLE_MS - 1), T0), { wait: 1 });
  assert.equal(registry.discover(started(registry.SETTLE_MS), T0).state, 'ready');
  // the helpers seen in the log were gone within about 2 s
  assert.ok(registry.SETTLE_MS > 2 * SEC);
});

test('a record that has a status is never held back', () => {
  for (const status of ['idle', 'busy']) {
    const got = registry.discover(record({ startedAt: T0 - 200, pstart: T0 - 600, status, statusAt: T0 - 100 }), T0);
    assert.equal(got.wait, undefined);
    assert.equal(got.state, status === 'idle' ? 'ready' : 'working');
  }
});

test('with no start time in the record, its age is the process\'s; with neither, it is not held back', () => {
  assert.deepEqual(registry.discover(record({ startedAt: null, pstart: T0 - 500 }), T0), { wait: registry.SETTLE_MS - 500 });
  assert.equal(registry.discover(record({ startedAt: null, pstart: T0 - MIN }), T0).state, 'ready');
  const unknown = registry.discover(record({ startedAt: null, pstart: null }), T0);
  assert.deepEqual([unknown.state, unknown.since, unknown.turnStart], ['ready', T0, null]);
  // nor is one whose clock reading is ahead of ours: it would never come of age
  assert.equal(registry.discover(record({ startedAt: T0 + 5 * MIN, pstart: null }), T0).state, 'ready');
});

test('a busy status written just after a record was discovered is caught', () => {
  const rec = record({ startedAt: T0 - registry.SETTLE_MS, pstart: null });
  const s = registry.discover(rec, T0);
  assert.equal(s.state, 'ready');
  // nothing to correct while the record still says nothing
  assert.equal(registry.drift(s, rec), null);
  // 300 ms later the process writes its first status: well inside the margin
  // that a session heard from by hook would need
  const busy = Object.assign({}, rec, { status: 'busy', statusAt: T0 + 300 });
  assert.ok(busy.statusAt <= s.lastEvent + registry.HOOK_MARGIN_MS);
  assert.deepEqual(registry.drift(s, busy), { state: 'working', since: T0 + 300, turnStart: T0 + 300, detail: null });
  // and so is a status that was a moment older than the discovery itself
  const earlier = Object.assign({}, rec, { status: 'busy', statusAt: T0 - 5 });
  assert.equal(registry.drift(s, earlier).state, 'working');
});

test('a session known only from the registry goes on following it', () => {
  const rec = record({ status: 'busy', statusAt: T0 - 400 });
  const s = registry.discover(rec, T0);
  assert.equal(s.state, 'working');
  assert.equal(registry.drift(s, rec), null); // already what the registry says
  // the turn ends half a second after the session was found
  const idle = Object.assign({}, rec, { status: 'idle', statusAt: T0 + 500 });
  const fix = registry.drift(s, idle);
  assert.deepEqual(fix, { state: 'ready', since: T0 + 500, tool: null, waitKind: null, turnStart: null, detail: null, unreadAt: T0 + 500 });
  Object.assign(s, fix);
  assert.equal(registry.drift(s, idle), null);
  // and the next one starts
  const again = Object.assign({}, rec, { status: 'busy', statusAt: T0 + 900 });
  assert.equal(registry.drift(s, again).state, 'working');
});

test('once a session has posted a hook, only a clearly newer status corrects it', () => {
  const ready = heard('ready', T0);
  const busyAt = (statusAt) => record({ status: 'busy', statusAt });
  assert.equal(registry.drift(ready, busyAt(T0 - 50)), null); // the status the hook came with
  assert.equal(registry.drift(ready, busyAt(T0 + 300)), null);
  assert.equal(registry.drift(ready, busyAt(T0 + registry.HOOK_MARGIN_MS)), null);
  // a prompt the widget missed
  assert.deepEqual(registry.drift(ready, busyAt(T0 + registry.HOOK_MARGIN_MS + 1)), {
    state: 'working',
    since: T0 + registry.HOOK_MARGIN_MS + 1,
    turnStart: T0 + registry.HOOK_MARGIN_MS + 1,
    detail: null,
  });

  const working = heard('working', T0);
  const idleAt = (statusAt) => record({ status: 'idle', statusAt });
  assert.equal(registry.drift(working, idleAt(T0 + 300)), null);
  // a Stop the widget missed: the turn's result waits to be looked at
  const fix = registry.drift(working, idleAt(T0 + 2 * MIN));
  assert.deepEqual([fix.state, fix.since, fix.turnStart, fix.unreadAt], ['ready', T0 + 2 * MIN, null, T0 + 2 * MIN]);
});

test('a status that agrees with the session, or is missing, changes nothing', () => {
  const later = T0 + 5 * MIN;
  assert.equal(registry.drift(heard('working', T0), record({ status: 'busy', statusAt: later })), null);
  assert.equal(registry.drift(heard('working', T0), record({ status: 'shell', statusAt: later })), null);
  assert.equal(registry.drift(heard('ready', T0), record({ status: 'idle', statusAt: later })), null);
  assert.equal(registry.drift(heard('ready', T0), record()), null);
  assert.equal(registry.drift(heard('working', T0), record()), null);
  // a status without its time cannot be placed against the last hook event
  assert.equal(registry.drift(heard('ready', T0), record({ status: 'busy' })), null);
  // a session waiting on the user is not this function's to move
  const waiting = Object.assign(heard('permission', T0), { waitKind: 'permission' });
  assert.equal(registry.drift(waiting, record({ status: 'idle', statusAt: later })), null);
  assert.equal(registry.drift(waiting, record({ status: 'busy', statusAt: later })), null);
});
