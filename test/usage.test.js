const test = require('node:test');
const assert = require('node:assert/strict');
const usage = require('../lib/usage');

const MIN = 60 * 1000;
const T0 = Date.UTC(2026, 10, 24, 9, 0, 0);

const fresh = (now, extra) => {
  const s = usage.createState();
  usage.apply(s, [
    { key: 'session', label: '5h', percent: 10, resetsAt: null, asOf: now, source: 'statusline' },
    { key: 'weekly', label: 'Week', percent: 20, resetsAt: null, asOf: now, source: 'statusline' },
  ]);
  s.lastOkAt = now;
  return Object.assign(s, extra);
};

test('the status line payload gives the 5-hour and weekly figures', () => {
  const got = usage.fromStatusLine(
    { rate_limits: { five_hour: { used_percentage: 23.5, resets_at: 1738425600 }, seven_day: { used_percentage: 41.2, resets_at: 1738857600 } } },
    T0
  );
  assert.deepEqual(
    got.map((r) => [r.key, r.label, r.percent, r.resetsAt, r.asOf, r.source]),
    [
      ['session', '5h', 24, 1738425600000, T0, 'statusline'],
      ['weekly', 'Week', 41, 1738857600000, T0, 'statusline'],
    ]
  );
});

test('a status line payload may lack either window, or all of them', () => {
  assert.deepEqual(usage.fromStatusLine({}, T0), []);
  assert.deepEqual(usage.fromStatusLine({ rate_limits: null }, T0), []);
  assert.deepEqual(usage.fromStatusLine(null, T0), []);
  const only = usage.fromStatusLine({ rate_limits: { seven_day: { used_percentage: 150 } } }, T0);
  assert.equal(only.length, 1);
  assert.equal(only[0].key, 'weekly');
  assert.equal(only[0].percent, 100); // clamped
  assert.equal(only[0].resetsAt, null);
  // a window with no percentage is no reading at all
  assert.deepEqual(usage.fromStatusLine({ rate_limits: { five_hour: { resets_at: 1738425600 } } }, T0), []);
});

test('the endpoint answer gives all three, by limits[] or by the older fields', () => {
  const byLimits = usage.fromApi(
    {
      limits: [
        { kind: 'session', percent: 42, resets_at: '2026-11-24T11:10:00Z' },
        { kind: 'weekly_all', percent: 61, resets_at: '2026-11-26T13:00:00Z' },
        { kind: 'weekly_scoped', percent: 28, resets_at: '2026-11-27T11:00:00Z', scope: { model: { display_name: 'Fable' } } },
      ],
    },
    T0
  );
  assert.deepEqual(
    byLimits.map((r) => [r.key, r.label, r.percent]),
    [
      ['session', '5h', 42],
      ['weekly', 'Week', 61],
      ['model', 'Fable', 28],
    ]
  );
  assert.equal(byLimits[0].resetsAt, Date.parse('2026-11-24T11:10:00Z'));
  assert.equal(byLimits[0].source, 'api');

  const byFields = usage.fromApi({ five_hour: { utilization: 7, resets_at: '2026-11-24T11:10:00Z' }, seven_day: { utilization: 9 } }, T0);
  assert.deepEqual(
    byFields.map((r) => [r.key, r.percent]),
    [
      ['session', 7],
      ['weekly', 9],
    ]
  );
  assert.deepEqual(usage.fromApi({}, T0), []);
  assert.deepEqual(usage.fromApi(null, T0), []);
});

test('a figure that is missing is no figure, not an empty gauge', () => {
  assert.deepEqual(usage.fromStatusLine({ rate_limits: { five_hour: { used_percentage: null, resets_at: 1738425600 } } }, T0), []);
  assert.deepEqual(usage.fromStatusLine({ rate_limits: { five_hour: { used_percentage: '', resets_at: 1738425600 } } }, T0), []);
  assert.deepEqual(usage.fromStatusLine({ rate_limits: { five_hour: { used_percentage: false } } }, T0), []);
  assert.deepEqual(usage.fromApi({ five_hour: { utilization: null }, seven_day: { utilization: [] } }, T0), []);
  assert.deepEqual(usage.fromApi({ limits: [{ kind: 'session', percent: null }] }, T0), []);
  // nought is a figure, and so is a number written as text
  assert.equal(usage.fromStatusLine({ rate_limits: { five_hour: { used_percentage: 0 } } }, T0)[0].percent, 0);
  assert.equal(usage.fromStatusLine({ rate_limits: { five_hour: { used_percentage: '12.4' } } }, T0)[0].percent, 12);
});

test('an idle session\'s status line does not pass old figures off as new', () => {
  const HOUR = 60 * MIN;
  const window1 = (T0 + 2 * HOUR) / 1000; // reset times, in the seconds Claude Code sends
  const window2 = (T0 + 7 * HOUR) / 1000;
  const say = (percent, resets) => usage.fromStatusLine({ rate_limits: { five_hour: { used_percentage: percent, resets_at: resets } } }, 0);
  const s = usage.createState();
  const bar = (now) => usage.snapshot(s, now).bars[0];

  // a session in a turn: its figures are the latest there are
  assert.equal(usage.applyStatusLine(s, say(40, window1), { now: T0, fresh: true, activeAt: T0 }), true);
  assert.deepEqual([bar(T0).percent, bar(T0).asOf], [40, T0]);

  // another session, idle for an hour, has its status line re-run: it still
  // carries what it was told an hour ago, which is less than is known now
  const later = T0 + 10 * MIN;
  assert.equal(usage.applyStatusLine(s, say(25, window1), { now: later, fresh: false, activeAt: T0 - 60 * MIN }), false);
  assert.deepEqual([bar(later).percent, bar(later).asOf], [40, T0]);
  // nor does it make the figure younger by repeating it
  assert.equal(usage.applyStatusLine(s, say(40, window1), { now: later, fresh: false, activeAt: T0 - 60 * MIN }), false);
  assert.equal(bar(later).asOf, T0);

  // an idle session that knows more (further into the same window) is believed,
  // as of when it was last active, not as of now
  assert.equal(usage.applyStatusLine(s, say(55, window1), { now: later, fresh: false, activeAt: T0 + 4 * MIN }), true);
  assert.deepEqual([bar(later).percent, bar(later).asOf], [55, T0 + 4 * MIN]);
  // and so is one that has seen a later window
  assert.equal(usage.applyStatusLine(s, say(3, window2), { now: later, fresh: false, activeAt: T0 + 6 * MIN }), true);
  assert.deepEqual([bar(later).percent, bar(later).resetsAt, bar(later).asOf], [3, window2 * 1000, T0 + 6 * MIN]);
  // but never one from the window before
  assert.equal(usage.applyStatusLine(s, say(99, window1), { now: later, fresh: false, activeAt: T0 + 8 * MIN }), false);
  assert.equal(bar(later).percent, 3);

  // with nothing known at all, an idle session's figures are better than none
  const empty = usage.createState();
  assert.equal(usage.applyStatusLine(empty, say(25, window1), { now: later, fresh: false, activeAt: T0 - 60 * MIN }), true);
  assert.deepEqual([usage.snapshot(empty, later).bars[0].percent, usage.snapshot(empty, later).bars[0].asOf], [25, T0 - 60 * MIN]);

  // a fresh one always wins, even downwards (a new window with no reset time yet)
  assert.equal(usage.applyStatusLine(s, say(1, undefined), { now: later, fresh: true, activeAt: later }), true);
  assert.deepEqual([bar(later).percent, bar(later).asOf], [1, later]);
  assert.equal(usage.applyStatusLine(s, [], { now: later, fresh: true, activeAt: later }), false);
});

test('the snapshot lists the figures outer gauge first and drops ancient ones', () => {
  const s = usage.createState();
  usage.apply(s, usage.fromApi({ limits: [{ kind: 'weekly_scoped', percent: 5, scope: { model: { display_name: 'Opus' } } }] }, T0));
  usage.apply(s, usage.fromStatusLine({ rate_limits: { seven_day: { used_percentage: 3 }, five_hour: { used_percentage: 1 } } }, T0 + MIN));
  assert.deepEqual(
    usage.snapshot(s, T0 + 2 * MIN).bars.map((b) => [b.key, b.label, b.asOf]),
    [
      ['session', '5h', T0 + MIN],
      ['weekly', 'Week', T0 + MIN],
      ['model', 'Opus', T0],
    ]
  );
  assert.deepEqual(usage.snapshot(s, T0 + usage.KEEP_MS + 2 * MIN).bars, []);
});

test('credentials: the token, and whether it has run out', () => {
  assert.deepEqual(usage.credentials(null, T0), { token: null, expiresAt: null, expired: false });
  assert.deepEqual(usage.credentials({ claudeAiOauth: {} }, T0), { token: null, expiresAt: null, expired: false });
  // milliseconds, as Claude Code writes it
  assert.equal(usage.credentials({ claudeAiOauth: { accessToken: 't', expiresAt: T0 + 60 * MIN } }, T0).expired, false);
  assert.equal(usage.credentials({ claudeAiOauth: { accessToken: 't', expiresAt: T0 - 1 } }, T0).expired, true);
  // about to: not worth a request that would be refused on arrival
  assert.equal(usage.credentials({ claudeAiOauth: { accessToken: 't', expiresAt: T0 + 30 * 1000 } }, T0).expired, true);
  // seconds are understood too
  assert.equal(usage.credentials({ claudeAiOauth: { accessToken: 't', expiresAt: (T0 - 5000) / 1000 } }, T0).expired, true);
  // an expiry that is missing or zero says nothing, so the token is tried
  assert.equal(usage.credentials({ claudeAiOauth: { accessToken: 't', expiresAt: 0 } }, T0).expired, false);
  assert.equal(usage.credentials({ claudeAiOauth: { accessToken: 't' } }, T0).expired, false);
});

test('the endpoint is not asked without a sign-in, or with an expired one', () => {
  const s = usage.createState();
  assert.equal(usage.decide(s, { now: T0, reason: 'startup', token: null }).fetch, false);
  assert.equal(usage.decide(s, { now: T0, reason: 'startup', token: 't', expired: true }).fetch, false);
  assert.equal(usage.decide(s, { now: T0, reason: 'hover', token: 't', expired: true }).fetch, false);
  assert.equal(usage.decide(s, { now: T0, reason: 'startup', token: 't', expired: false }).fetch, true);
});

test('it is asked at most once in five minutes, however often the tray is opened', () => {
  const s = usage.createState();
  const ctx = (now, reason) => ({ now, reason, token: 't', expired: false, active: true });
  assert.equal(usage.decide(s, ctx(T0, 'hover')).fetch, true);
  usage.onAttempt(s, T0);
  usage.onFailure(s, T0, {}); // a dropped connection: free to try again in two minutes...
  assert.equal(usage.decide(s, ctx(T0 + 3 * MIN, 'hover')).fetch, false); // ...but not within five
  assert.equal(usage.decide(s, ctx(T0 + 3 * MIN, 'stop')).fetch, false);
  assert.equal(usage.decide(s, ctx(T0 + 3 * MIN, 'timer')).fetch, false);
  assert.equal(usage.decide(s, ctx(T0 + 5 * MIN + 1, 'hover')).fetch, true);
});

test('with fresh figures from the status line, only the endpoint-only figure prompts a request', () => {
  const s = fresh(T0);
  const ctx = (now, reason, active = true) => ({ now, reason, token: 't', expired: false, active });
  assert.equal(usage.decide(s, ctx(T0 + MIN, 'startup')).fetch, false);
  assert.equal(usage.decide(s, ctx(T0 + 6 * MIN, 'stop')).fetch, false);
  // the status line keeps the live figures fresh...
  usage.apply(s, usage.fromStatusLine({ rate_limits: { five_hour: { used_percentage: 11 }, seven_day: { used_percentage: 21 } } }, T0 + 16 * MIN));
  // ...so it is the endpoint's own age that brings the next request
  assert.equal(usage.decide(s, ctx(T0 + 16 * MIN, 'stop')).fetch, true);
  assert.equal(usage.decide(s, ctx(T0 + 16 * MIN, 'hover')).fetch, true);
  assert.equal(usage.decide(s, ctx(T0 + 16 * MIN, 'timer')).fetch, false); // unprompted: not before twenty
  assert.equal(usage.decide(s, ctx(T0 + 21 * MIN, 'timer')).fetch, true);
  assert.equal(usage.decide(s, ctx(T0 + 21 * MIN, 'timer', false)).fetch, false); // and never with nothing running
});

test('a refusal is waited out: ten minutes, doubling, an hour at most, and never less than asked', () => {
  const s = usage.createState();
  let now = T0;
  const waits = [];
  for (let i = 0; i < 6; i += 1) {
    usage.onAttempt(s, now);
    waits.push(usage.onFailure(s, now, { status: 429 }) / MIN);
    assert.equal(usage.decide(s, { now: s.retryAt - 1, reason: 'hover', token: 't', expired: false }).fetch, false);
    now = s.retryAt;
  }
  assert.deepEqual(waits, [10, 20, 40, 60, 60, 60]);

  const t = usage.createState();
  assert.equal(usage.onFailure(t, T0, { status: 429, retryAfter: 95 * MIN }), 95 * MIN);
  assert.equal(usage.onFailure(usage.createState(), T0, { status: 429, retryAfter: 3 * MIN }), 10 * MIN);
  assert.equal(usage.onFailure(usage.createState(), T0, { status: 401 }), usage.AUTH_RETRY_MS);
  assert.equal(usage.onFailure(usage.createState(), T0, { status: 403 }), usage.AUTH_RETRY_MS);
  assert.equal(usage.onFailure(usage.createState(), T0, {}), usage.NETWORK_RETRY_MS);
});

test('a new sign-in is tried at once, whatever was owed on the old one', () => {
  const s = usage.createState();
  usage.decide(s, { now: T0, reason: 'startup', token: 'old', expired: false });
  usage.onAttempt(s, T0);
  usage.onFailure(s, T0, { status: 401 });
  assert.equal(usage.decide(s, { now: T0 + 6 * MIN, reason: 'hover', token: 'old', expired: false }).fetch, false);
  assert.equal(usage.decide(s, { now: T0 + 6 * MIN, reason: 'hover', token: 'new', expired: false }).fetch, true);
  assert.equal(s.fails, 0);
});

test('success clears the backoff and records the figures', () => {
  const s = usage.createState();
  usage.onFailure(s, T0, { status: 429 });
  usage.onSuccess(s, T0 + 11 * MIN, usage.fromApi({ five_hour: { utilization: 50 } }, T0 + 11 * MIN));
  assert.equal(s.fails, 0);
  assert.equal(s.retryAt, 0);
  assert.equal(s.lastOkAt, T0 + 11 * MIN);
  assert.equal(usage.snapshot(s, T0 + 12 * MIN).bars[0].percent, 50);
});

test('Retry-After: seconds or a date, capped', () => {
  assert.equal(usage.retryAfterMs('471', T0), 471000);
  assert.equal(usage.retryAfterMs('0', T0), 0);
  assert.equal(usage.retryAfterMs(null, T0), 0);
  assert.equal(usage.retryAfterMs(new Date(T0 + 90 * 1000).toUTCString(), T0), 90000);
  assert.equal(usage.retryAfterMs('999999', T0), 2 * 60 * MIN);
  assert.equal(usage.retryAfterMs('soon', T0), 0);
});

test('the books survive a restart, and a restart is no way round a wait', () => {
  const s = fresh(T0);
  usage.onAttempt(s, T0 + MIN);
  usage.onFailure(s, T0 + MIN, { status: 429 });
  const back = usage.restore(JSON.parse(JSON.stringify(usage.serialize(s))), T0 + 2 * MIN);
  assert.deepEqual(usage.snapshot(back, T0 + 2 * MIN), usage.snapshot(s, T0 + 2 * MIN));
  assert.equal(back.retryAt, s.retryAt);
  // hours on, with every figure old enough to want, the wait still stands...
  const later = { now: s.retryAt - MIN, reason: 'startup', token: 't', expired: false };
  back.readings = {};
  back.lastOkAt = 0;
  assert.deepEqual(usage.decide(back, later), { fetch: false, why: 'backing off' });
  // ...for the same sign-in after another restart too, but not for a new one
  const again = usage.restore(JSON.parse(JSON.stringify(usage.serialize(back))), later.now);
  assert.equal(usage.decide(again, later).fetch, false);
  assert.equal(usage.decide(again, Object.assign({}, later, { token: 'another' })).fetch, true);
  // the token itself is never written down
  assert.ok(!JSON.stringify(usage.serialize(again)).includes('another'));
  // nonsense on disk is ignored, and a wait is never longer than one we could set
  assert.deepEqual(usage.restore('nope', T0).readings, {});
  assert.deepEqual(usage.restore({ readings: { session: { percent: 'x', asOf: T0 } } }, T0).readings, {});
  assert.equal(usage.restore({ retryAt: T0 + 99 * 60 * MIN }, T0).retryAt, T0 + 2 * 60 * MIN);
  // figures from before any window they could describe are not restored
  assert.deepEqual(usage.restore({ readings: { session: { percent: 5, asOf: T0 - usage.KEEP_MS - MIN } } }, T0).readings, {});
});
