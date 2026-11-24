// Plan usage: the figures Claude Code's /usage shows, and where they come from.
//
// Two sources, merged per figure by whichever was read last:
//
//  - Claude Code's status line. Claude Code hands its status line command the
//    5-hour and weekly percentages and reset times it has just been given by
//    the API (rate_limits in the command's stdin). It is documented, needs no
//    token, costs no request, and arrives with every reply, so while Claude
//    Code is in use in a terminal these two figures are always current. Only
//    the terminal UI has a status line: a session the Claude app hosts (its
//    Code tab, a cloud session) runs hooks but never this command, so a reply
//    there brings nothing.
//
//  - The /api/oauth/usage endpoint, read with Claude Code's sign-in token. It
//    is the only source for the top model's own weekly figure, and it fills in
//    the other two before any session has replied. It is undocumented, and it
//    answers 429 for hours at a time to anything that asks more than rarely,
//    so it is asked rarely: only when a figure it alone can give has grown
//    old, never twice within MIN_SPACING_MS, never with a token known to have
//    expired, and after a refusal not again until the wait it asked for (or a
//    doubling one of our own) has passed.
//
// Claude Code renews that token only when it makes a request of its own, from
// a terminal session (the Claude app signs its own sessions in), so for
// someone who works only in the app it lapses and stays lapsed, and neither
// source has anything. Two things see to that:
//
//  - When the token has expired and a figure is wanted, the answer here says
//    so (`renew`), and main.js has Claude Code renew its own sign-in by
//    running its /usage command in the background (lib/renew.js). No more
//    often than RENEW_SPACING_MS, and after a run that left the token expired
//    not again until a wait that doubles.
//
//  - Claude Code keeps the endpoint's last answer to it in its own config
//    file. That run leaves one there, and so does anyone typing /usage, so it
//    is read as a third source: no token, no request.
//
// A figure that could not be refreshed is not an error to report. It stays
// up, and the widget shows its age once it is old enough to matter.
//
// Nothing here touches the network or the disk: main.js does both, and this
// file decides and keeps the books, so all of it can be tested.

const crypto = require('crypto');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

const MIN_SPACING_MS = 5 * MIN; // between any two requests to the endpoint
const LIVE_AGE_MS = 5 * MIN; // 5-hour / weekly figures this old are worth refreshing on a look
const API_AGE_MS = 15 * MIN; // and the endpoint's own figure, this old
const TIMER_AGE_MS = 20 * MIN; // unprompted, while sessions are running, only this old
const BACKOFF_MS = 10 * MIN; // after a refusal; doubles with each one in a row
const BACKOFF_MAX_MS = HOUR;
const AUTH_RETRY_MS = 30 * MIN; // a rejected token is retried when it changes, or this much later
const NETWORK_RETRY_MS = 2 * MIN; // a dropped connection says nothing about the next attempt
const RETRY_AFTER_MAX_MS = 2 * HOUR;
const KEEP_MS = 8 * 24 * HOUR; // a figure older than any window it could describe is dropped
const RENEW_SPACING_MS = 15 * MIN; // between two runs of Claude Code to renew its sign-in
const RENEW_BACKOFF_MS = 30 * MIN; // after one that left it expired; doubles with each in a row
const RENEW_BACKOFF_MAX_MS = 6 * HOUR;

const ORDER = ['session', 'weekly', 'model'];

function createState() {
  return {
    readings: {}, // key -> { key, label, percent, resetsAt, asOf, source }
    lastAttemptAt: 0,
    lastOkAt: 0, // when the endpoint last answered
    fails: 0, // failed requests in a row
    retryAt: 0, // no request is sent before this
    tokenTag: null, // which sign-in token the last decision saw (a fingerprint, never the token)
    renewAt: 0, // Claude Code is not run to renew its sign-in before this
    renewFails: 0, // such runs in a row that left the token expired
  };
}

// Enough of a hash to tell one token from the next, and nothing to recover one from.
function tagOf(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 12);
}

// A percentage, or null for anything that is not a number (Number(null) is 0,
// and a missing figure must not read as an empty gauge).
function pct(v) {
  if (typeof v !== 'number' && !(typeof v === 'string' && v.trim())) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : null;
}

// An instant given as epoch seconds, epoch milliseconds, or an ISO string.
function instant(v) {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v < 1e12 ? v * 1000 : v;
  if (typeof v === 'string' && v) {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

function reading(key, label, percent, resetsAt, now, source) {
  return percent === null ? null : { key, label, percent, resetsAt: resetsAt || null, asOf: now, source };
}

// The status line command's stdin. Either window may be absent: Claude Code
// leaves one out until the API has reported it, and drops it once its reset
// time passes.
function fromStatusLine(payload, now) {
  const rl = payload && typeof payload === 'object' ? payload.rate_limits : null;
  if (!rl || typeof rl !== 'object') return [];
  const one = (key, label, w) =>
    w && typeof w === 'object' ? reading(key, label, pct(w.used_percentage), instant(w.resets_at), now, 'statusline') : null;
  return [one('session', '5h', rl.five_hour), one('weekly', 'Week', rl.seven_day)].filter(Boolean);
}

// The endpoint's answer: the 5-hour window, the weekly all-models window, and
// the weekly window scoped to the top model (named by the API, e.g. "Fable").
function fromApi(d, now) {
  if (!d || typeof d !== 'object') return [];
  const limits = Array.isArray(d.limits) ? d.limits : [];
  const one = (key, label, l, fallback) => {
    const percent = l ? pct(l.percent) : fallback ? pct(fallback.utilization) : null;
    return reading(key, label, percent, instant((l && l.resets_at) || (fallback && fallback.resets_at)), now, 'api');
  };
  const scoped = limits.find((l) => l && l.kind === 'weekly_scoped' && l.scope && l.scope.model);
  const scopedName = (scoped && scoped.scope.model.display_name) || 'Fable';
  return [
    one('session', '5h', limits.find((l) => l && l.kind === 'session'), d.five_hour),
    one('weekly', 'Week', limits.find((l) => l && l.kind === 'weekly_all'), d.seven_day),
    one('model', String(scopedName).slice(0, 16), scoped, d.seven_day_opus),
  ].filter(Boolean);
}

function apply(state, readings) {
  for (const r of readings) state.readings[r.key] = r;
  return readings.length > 0;
}

// Claude Code's own copy of the endpoint's last answer to it, from its config
// file (.claude.json): { fetchedAtMs, accountUuid, utilization }, where
// utilization is the endpoint's answer as fromApi reads it. Returns the
// figures dated to when Claude Code was given them, or null.
function fromCache(config, now) {
  const c = config && typeof config === 'object' ? config.cachedUsageUtilization : null;
  if (!c || typeof c !== 'object') return null;
  const at = typeof c.fetchedAtMs === 'number' && Number.isFinite(c.fetchedAtMs) ? c.fetchedAtMs : 0;
  // (a time from the future is not believed, give or take a clock's adjustment)
  if (at <= 0 || at > now + MIN || now - at > KEEP_MS) return null;
  // it is kept per account: one saved under another sign-in says nothing about this one
  const account = config.oauthAccount && config.oauthAccount.accountUuid;
  if (c.accountUuid && account && c.accountUuid !== account) return null;
  const asOf = Math.min(at, now);
  const readings = fromApi(c.utilization, asOf);
  return readings.length ? { at: asOf, readings } : null;
}

// Each figure is taken where it is newer than the one held (a status line may
// have said more since), and the endpoint counts as having answered then, so
// it is not asked again for what Claude Code has just been told. Returns true
// when anything changed.
function applyCached(state, cached) {
  if (!cached) return false;
  let changed = false;
  for (const r of cached.readings) {
    const cur = state.readings[r.key];
    if (cur && cur.asOf >= r.asOf) continue;
    state.readings[r.key] = r;
    changed = true;
  }
  if (cached.at > state.lastOkAt) {
    state.lastOkAt = cached.at;
    changed = true;
  }
  return changed;
}

const SAME_WINDOW_MS = 5 * MIN; // reset times this close are the same window

// Figures from a status line. Every session's status line carries the usage
// that session was told at its own last reply, and Claude Code re-runs status
// lines for reasons that have nothing to do with a reply (a mode change, the
// user's refreshInterval), so a session that has been sitting idle can send
// figures hours old. `fresh` says the session is in a turn or has just been
// heard from: then its figures are the latest there are. Otherwise they are
// taken only where they say more than is already known (a later window, or
// further into the same one), and dated to when that session was last active
// (`activeAt`), not to now. Returns true when anything changed.
function applyStatusLine(state, readings, { now, fresh, activeAt }) {
  let changed = false;
  for (const r of readings) {
    const cur = state.readings[r.key];
    if (fresh || !cur) {
      state.readings[r.key] = Object.assign({}, r, { asOf: fresh ? now : Math.min(now, activeAt || now) });
      changed = true;
      continue;
    }
    const later = Boolean(r.resetsAt && (!cur.resetsAt || r.resetsAt > cur.resetsAt + SAME_WINDOW_MS));
    const same = Boolean(r.resetsAt && cur.resetsAt && Math.abs(r.resetsAt - cur.resetsAt) <= SAME_WINDOW_MS);
    if (!later && !(same && r.percent > cur.percent)) continue;
    state.readings[r.key] = Object.assign({}, r, { asOf: Math.max(cur.asOf, Math.min(now, activeAt || 0)) });
    changed = true;
  }
  return changed;
}

// What the widget draws: the figures in gauge order, outer first.
function snapshot(state, now) {
  const bars = [];
  for (const key of ORDER) {
    const r = state.readings[key];
    if (!r || now - r.asOf > KEEP_MS) continue;
    bars.push({ key: r.key, label: r.label, percent: r.percent, resetsAt: r.resetsAt, asOf: r.asOf });
  }
  return { bars };
}

// Claude Code's sign-in, from its .credentials.json. The access token is short
// lived and Claude Code renews it only when it next needs it, so an expired
// one here does not mean the user is signed out: it means Claude Code has not
// run lately, and the token is not worth sending.
function credentials(json, now) {
  const o = json && json.claudeAiOauth;
  const token = o && typeof o.accessToken === 'string' && o.accessToken ? o.accessToken : null;
  const expiresAt = o ? instant(o.expiresAt) : null;
  return { token, expiresAt, expired: Boolean(token && expiresAt && expiresAt <= now + MIN) };
}

// Retry-After is a number of seconds or an HTTP date.
function retryAfterMs(value, now) {
  if (!value) return 0;
  const secs = Number(value);
  const ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(value) - now;
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, RETRY_AFTER_MAX_MS) : 0;
}

// Should the endpoint be asked now? reason is what prompted the question:
// 'startup', 'hover' (the tray was opened), 'stop' (a turn ended, so the
// model's figure has moved) or 'timer'. active: sessions are running.
//
// With an expired token the answer is no, and `renew: true` when a request
// would have gone out with a good one: then it is worth having Claude Code
// renew its sign-in (see the top of this file), unless that was tried lately.
function decide(state, { now, reason, token, expired, active }) {
  const no = (why) => ({ fetch: false, why });
  if (!token) return no('not signed in');
  const tag = tagOf(token);
  if (tag !== state.tokenTag) {
    // a new sign-in is worth trying at once, whatever was owed on the old one.
    // (With no token on record there is no telling, and a wait stands.) The
    // wait between renewals stands too: a renewal is what changes the token,
    // and one that left a different token just as expired has not earned
    // another.
    if (state.tokenTag) {
      state.fails = 0;
      state.retryAt = 0;
    }
    state.tokenTag = tag;
  }
  const wanted = () => {
    if (now < state.retryAt) return 'backing off';
    if (reason !== 'startup' && now - state.lastAttemptAt < MIN_SPACING_MS) return 'asked recently';
    const age = (key) => (state.readings[key] ? now - state.readings[key].asOf : Infinity);
    const live = Math.max(age('session'), age('weekly'));
    const api = now - state.lastOkAt;
    let want = false;
    if (reason === 'startup' || reason === 'hover') want = live > LIVE_AGE_MS || api > API_AGE_MS;
    else if (reason === 'stop') want = api > API_AGE_MS;
    else if (reason === 'timer') want = Boolean(active) && (live > TIMER_AGE_MS || api > TIMER_AGE_MS);
    return want ? null : 'fresh enough';
  };
  if (expired) {
    return wanted() === null && now >= state.renewAt ? { fetch: false, why: 'token expired', renew: true } : no('token expired');
  }
  const why = wanted();
  return why === null ? { fetch: true, why: reason } : no(why);
}

function onAttempt(state, now) {
  state.lastAttemptAt = now;
}

function onSuccess(state, now, readings) {
  state.fails = 0;
  state.retryAt = 0;
  state.lastOkAt = now;
  apply(state, readings);
}

// failure: { status } for an HTTP refusal (with retryAfter in ms when the
// server named one), or {} for a dropped connection or a timeout. Returns how
// long the endpoint is left alone.
function onFailure(state, now, failure) {
  const status = failure && failure.status;
  state.fails += 1;
  let wait = NETWORK_RETRY_MS;
  if (status === 401 || status === 403) wait = AUTH_RETRY_MS;
  else if (status) wait = Math.min(BACKOFF_MAX_MS, BACKOFF_MS * 2 ** Math.min(state.fails - 1, 6));
  wait = Math.max(wait, (failure && failure.retryAfter) || 0);
  state.retryAt = now + wait;
  return wait;
}

// Claude Code is being run to renew its sign-in: not again for a while,
// whatever comes of it.
function onRenewStart(state, now) {
  state.renewAt = now + RENEW_SPACING_MS;
}

// ok: the run left an unexpired token behind. Returns how long before another
// may start; a token that is still expired (signed out, offline, no Claude
// Code to run) is left longer each time.
function onRenewResult(state, now, ok) {
  let wait = RENEW_SPACING_MS;
  if (ok) {
    state.renewFails = 0;
  } else {
    state.renewFails += 1;
    wait = Math.min(RENEW_BACKOFF_MAX_MS, RENEW_BACKOFF_MS * 2 ** Math.min(state.renewFails - 1, 6));
  }
  state.renewAt = now + wait;
  return wait;
}

// The books survive a restart: the last figures show at once (with their
// age), and a restart is no way round a wait the endpoint asked for.
function serialize(state) {
  return {
    readings: state.readings,
    lastAttemptAt: state.lastAttemptAt,
    lastOkAt: state.lastOkAt,
    fails: state.fails,
    retryAt: state.retryAt,
    tokenTag: state.tokenTag,
    renewAt: state.renewAt,
    renewFails: state.renewFails,
  };
}

function restore(saved, now) {
  const state = createState();
  if (!saved || typeof saved !== 'object') return state;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= now ? v : 0);
  state.lastAttemptAt = num(saved.lastAttemptAt);
  state.lastOkAt = num(saved.lastOkAt);
  state.fails = Math.min(20, Math.round(num(saved.fails)));
  state.tokenTag = typeof saved.tokenTag === 'string' && /^[0-9a-f]{12}$/.test(saved.tokenTag) ? saved.tokenTag : null;
  // a wait is kept, but never longer than one we could have set ourselves
  if (typeof saved.retryAt === 'number' && Number.isFinite(saved.retryAt)) {
    state.retryAt = Math.min(saved.retryAt, now + RETRY_AFTER_MAX_MS);
  }
  state.renewFails = Math.min(20, Math.round(num(saved.renewFails)));
  if (typeof saved.renewAt === 'number' && Number.isFinite(saved.renewAt)) {
    state.renewAt = Math.min(saved.renewAt, now + RENEW_BACKOFF_MAX_MS);
  }
  const readings = saved.readings && typeof saved.readings === 'object' ? saved.readings : {};
  for (const key of ORDER) {
    const r = readings[key];
    if (!r || typeof r !== 'object') continue;
    const percent = pct(r.percent);
    const asOf = num(r.asOf);
    if (percent === null || !asOf || now - asOf > KEEP_MS) continue;
    state.readings[key] = {
      key,
      label: typeof r.label === 'string' && r.label ? r.label.slice(0, 16) : key,
      percent,
      resetsAt: instant(r.resetsAt),
      asOf,
      source: r.source === 'statusline' ? 'statusline' : 'api',
    };
  }
  return state;
}

module.exports = {
  MIN_SPACING_MS,
  LIVE_AGE_MS,
  API_AGE_MS,
  TIMER_AGE_MS,
  BACKOFF_MS,
  BACKOFF_MAX_MS,
  AUTH_RETRY_MS,
  NETWORK_RETRY_MS,
  KEEP_MS,
  RENEW_SPACING_MS,
  RENEW_BACKOFF_MS,
  RENEW_BACKOFF_MAX_MS,
  createState,
  fromStatusLine,
  fromApi,
  apply,
  fromCache,
  applyCached,
  applyStatusLine,
  snapshot,
  credentials,
  retryAfterMs,
  decide,
  onAttempt,
  onSuccess,
  onFailure,
  onRenewStart,
  onRenewResult,
  serialize,
  restore,
};
