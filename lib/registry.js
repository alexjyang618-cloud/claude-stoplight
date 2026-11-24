// Claude Code's process registry, and how far the widget takes its word.
//
// Claude Code keeps one small file per running process in its sessions folder
// (main.js reads them: readSessionRegistry). A record may carry a coarse
// status, one of busy, shell, idle and waiting, with the time it was written;
// a waiting one also says what it is waiting for. It may also carry none: a
// process that has only just started has not written one yet, some helper
// processes exit before they ever do, and a Code-tab session of the Claude
// desktop app has been seen running without one.
//
// Hook events are the widget's first source for what a session is doing. The
// registry fills in for a session the widget has not heard from (one already
// open when the widget started, say), corrects a state that a missed hook
// left behind, and follows a dialog from the moment it opens to the moment it
// is answered, which no hook marks.
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

// A status this soon after a wait began is not yet its answer.
const ANSWER_MARGIN_MS = 500;

// A menu the user opened themselves (/config, say) is recorded as waiting
// too, for this. It is not Claude waiting on them, and it says nothing about
// whether a turn is running underneath.
const OWN_DIALOG = 'dialog open';

// What a record's status says the session is doing: 'working', 'ready',
// 'permission' (blocked on a dialog only the user can answer), or null when it
// does not say.
function stateOf(rec) {
  if (!rec.status) return null;
  if (rec.status === 'idle') return 'ready';
  if (rec.status !== 'waiting') return 'working'; // busy, shell, or one not seen yet
  return rec.waitingFor === OWN_DIALOG ? null : 'permission';
}

// Which kind of wait a waiting record is: for leave to do something, or for
// an answer.
function waitKind(rec) {
  return /permission|sandbox|worker/i.test(rec.waitingFor || '') ? 'permission' : 'question';
}

// What to make of the record of a live process the widget has no session for.
// Returns { wait }, the milliseconds until the record is old enough to judge,
// or the part of the new session that says what it is doing.
//
// Only a status that says so makes the session working, or waiting on the
// user. With none it is ready: a session that really is working posts a hook
// within seconds, which turns it yellow, but an idle one posts nothing, so a
// wrong "working" would stay up until its next prompt.
//
// One found already waiting is red at once, with the wait counted from when
// it began, like a wait restored from before a restart of the widget: however
// long ago the dialog opened, it is still the user it is waiting for.
function discover(rec, now) {
  if (!rec.status) {
    const born = rec.startedAt || rec.pstart;
    const age = born ? now - born : SETTLE_MS;
    if (age >= 0 && age < SETTLE_MS) return { wait: SETTLE_MS - age };
  }
  const state = stateOf(rec) || 'ready';
  const since = rec.statusAt || rec.startedAt || now;
  return {
    state,
    since,
    lastEvent: now,
    waitKind: state === 'permission' ? waitKind(rec) : null,
    turnStart: state === 'ready' ? null : since,
    // all that is known of it comes from the registry, until its first hook
    // event replaces this record (setSession in main.js)
    registryOnly: true,
  };
}

// Follow a dialog through the registry: Claude Code marks a session waiting
// while a permission prompt or a question is up, and writes a newer status
// the moment it is answered. Returns the change to the session, or null.
function dialog(s, rec) {
  if (!rec.status || !rec.statusAt) return null;
  if (s.state === 'permission') {
    if (rec.status === 'waiting' || rec.statusAt <= s.since + ANSWER_MARGIN_MS) return null;
    return rec.status === 'idle'
      ? { state: 'ready', since: rec.statusAt, tool: null, waitKind: null, turnStart: null, detail: null }
      : { state: 'working', since: rec.statusAt, waitKind: null };
  }
  // a dialog that opened after the last hook event (a question, say, which
  // has no hook of its own; a permission prompt usually gets here by its hook
  // first)
  if (stateOf(rec) !== 'permission' || rec.statusAt <= s.lastEvent) return null;
  return { state: 'permission', since: rec.statusAt, waitKind: waitKind(rec) };
}

// The change that brings a session's working / ready state back in line with
// the registry's status, or null when there is nothing to correct. A session
// blocked on a dialog is dialog()'s to move, and a menu of the user's own
// moves nothing: taken for work, it would turn an idle session yellow, and
// closing it would then pass for the end of a turn.
//
// A session that has posted hooks is corrected only by a status clearly newer
// than the last of them: a Stop or a prompt the widget missed. One known only
// from the registry has no hook to weigh the status against, so it follows
// the registry as it stands; otherwise a status written in the moments after
// the session was found would be passed over for good.
function drift(s, rec) {
  if (!rec.status || !rec.statusAt) return null;
  if (!s.registryOnly && rec.statusAt <= s.lastEvent + HOOK_MARGIN_MS) return null;
  const says = stateOf(rec);
  if (says === 'ready' && s.state === 'working') {
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
  if (says === 'working' && s.state === 'ready') {
    return { state: 'working', since: rec.statusAt, turnStart: rec.statusAt, detail: null };
  }
  return null;
}

module.exports = { SETTLE_MS, HOOK_MARGIN_MS, ANSWER_MARGIN_MS, stateOf, waitKind, discover, dialog, drift };
