// Claude Code's process registry, and how far the widget takes its word.
//
// Claude Code keeps one small file per running process in its sessions folder
// (main.js reads them: readSessionRegistry). A record may carry a coarse
// status, one of busy, shell, idle and waiting, with the time it was written.
// It may also carry none: a process that has only just started has not written
// one yet, some helper processes exit before they ever do, and a Code-tab
// session of the Claude desktop app has been seen running without one.
//
// Hook events are the widget's first source for what a session is doing. The
// registry fills in for a session the widget has not heard from (one already
// open when the widget started, say), and corrects a state that a missed hook
// left behind.
//
// Nothing here reads a file or keeps a timer: main.js does both, and this file
// decides, so all of it can be tested.

// A record with no status is left alone until it is this old, so that a helper
// process which starts and exits within a couple of seconds is never drawn as
// a session (the ones seen lived up to about 2 s). A real session does not
// wait for this: its SessionStart hook adds it at once.
const SETTLE_MS = 3000;

// Once a session has been heard from, a registry status corrects it only when
// it is this much newer than the last hook event.
const HOOK_MARGIN_MS = 1000;

// What to make of the record of a live process the widget has no session for.
// Returns { wait }, the milliseconds until the record is old enough to judge,
// or the part of the new session that says what it is doing.
//
// Only a status that says so makes the session working. With none it is
// ready: a session that really is working posts a hook within seconds, which
// turns it yellow, but an idle one posts nothing, so a wrong "working" would
// stay up until its next prompt.
function discover(rec, now) {
  if (!rec.status) {
    const born = rec.startedAt || rec.pstart;
    const age = born ? now - born : SETTLE_MS;
    if (age >= 0 && age < SETTLE_MS) return { wait: SETTLE_MS - age };
  }
  const working = Boolean(rec.status) && rec.status !== 'idle';
  const since = rec.statusAt || rec.startedAt || now;
  return {
    state: working ? 'working' : 'ready',
    since,
    lastEvent: now,
    turnStart: working ? since : null,
    // all that is known of it comes from the registry, until its first hook
    // event replaces this record (setSession in main.js)
    registryOnly: true,
  };
}

// The change that brings a session's working / ready state back in line with
// the registry's status, or null when there is nothing to correct. (A session
// blocked on a dialog is followed separately: applyRegistryWait in main.js.)
//
// A session that has posted hooks is corrected only by a status clearly newer
// than the last of them: a Stop or a prompt the widget missed. One known only
// from the registry has no hook to weigh the status against, so it follows
// the registry as it stands; otherwise a status written in the moments after
// the session was found would be passed over for good.
function drift(s, rec) {
  if (!rec.status || !rec.statusAt) return null;
  if (!s.registryOnly && rec.statusAt <= s.lastEvent + HOOK_MARGIN_MS) return null;
  if (rec.status === 'idle' && s.state === 'working') {
    return {
      state: 'ready',
      since: rec.statusAt,
      tool: null,
      waitKind: null,
      turnStart: null,
      detail: null,
      unreadAt: rec.statusAt,
    };
  }
  if (rec.status !== 'idle' && s.state === 'ready') {
    return { state: 'working', since: rec.statusAt, turnStart: rec.statusAt, detail: null };
  }
  return null;
}

module.exports = { SETTLE_MS, HOOK_MARGIN_MS, discover, drift };
