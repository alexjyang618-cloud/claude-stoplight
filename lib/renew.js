// Claude Code's sign-in, renewed by Claude Code itself.
//
// The usage endpoint (lib/usage.js) takes Claude Code's sign-in token. That
// token lasts some hours, and Claude Code renews it only when it next makes a
// request of its own, which it does from a terminal session. The Claude app
// signs its own sessions in, so someone who works there never renews it, and
// Clawd, which will not send an expired token, has no figures.
//
// Clawd does not renew the token itself. That would mean taking the sign-in's
// refresh token and rewriting Claude Code's credentials file under it. It has
// Claude Code do what a person at a terminal would: run /usage. Run with -p
// that is not a conversation; it sends nothing to a model and takes a second
// or two. Claude Code renews its sign-in to ask the endpoint, and keeps the
// answer in its config file, where lib/usage.js reads it.
//
// The run is kept to itself:
//   --setting-sources local    none of the user's settings, so none of their
//                              hooks (ours among them) fire for it
//   --strict-mcp-config        none of their MCP servers are started
//   --no-session-persistence   no transcript is left behind
// and it runs in a folder of its own, by which the widget knows its entry in
// Claude Code's session registry and keeps it out of the sessions list.
//
// This file finds Claude Code and describes the run; main.js decides when
// (lib/usage.js: decide) and reads what it left.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DIR = 'usage-renewal'; // the run's working folder, inside the widget's data folder
const ARGS = ['-p', '/usage', '--setting-sources', 'local', '--strict-mcp-config', '--no-session-persistence'];
const TIMEOUT_MS = 60 * 1000;

const pathFor = (platform) => (platform === 'win32' ? path.win32 : path.posix);

// Windows names its variables without regard to case (Path, PATH).
function envValue(env, name, platform) {
  if (platform !== 'win32') return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

// Where Claude Code may be, likeliest first: where its own installer puts it,
// then anywhere on PATH (an npm install is a .cmd there).
function candidates(env, platform) {
  const p = pathFor(platform);
  const win = platform === 'win32';
  const names = win ? ['claude.exe', 'claude.cmd'] : ['claude'];
  const home = envValue(env, win ? 'USERPROFILE' : 'HOME', platform);
  const dirs = [];
  if (home) dirs.push(p.join(home, '.local', 'bin'));
  for (const dir of String(envValue(env, 'PATH', platform) || '').split(p.delimiter)) {
    // a PATH entry may be quoted on Windows; an empty or relative one means
    // the working folder, which is no place to go looking for a program
    const clean = dir.trim().replace(/^"(.*)"$/, '$1');
    if (clean && p.isAbsolute(clean)) dirs.push(clean);
  }
  const seen = new Set();
  const list = [];
  for (const dir of dirs) {
    for (const name of names) {
      const file = p.join(dir, name);
      const key = win ? file.toLowerCase() : file;
      if (seen.has(key)) continue;
      seen.add(key);
      list.push(file);
    }
  }
  return list;
}

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

// How to start one of those: { file, args, verbatim }. A .cmd cannot be
// started directly, only through cmd.exe, whose command line is one string
// with its own quoting: the whole of it in quotes after /s /c, the path in
// quotes within. A path cmd would read into ('"', or '%' for a variable) is
// not run at all. Returns null for those.
function launcher(file, platform, env) {
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(file)) return { file, args: ARGS.slice(), verbatim: false };
  if (/["%]/.test(file)) return null;
  return {
    file: envValue(env || {}, 'ComSpec', platform) || 'cmd.exe',
    args: ['/d', '/s', '/c', `""${file}" ${ARGS.join(' ')}"`],
    verbatim: true,
  };
}

// The first Claude Code there is, ready to start; or null.
function find(env, platform, exists = isFile) {
  for (const file of candidates(env, platform)) {
    if (!exists(file)) continue;
    const l = launcher(file, platform, env);
    if (l) return Object.assign(l, { found: file });
  }
  return null;
}

// The widget's own environment, less what would make Claude Code take itself
// for part of another session (set when the widget was started from inside
// one), and with its self-update left for a run someone is watching.
const NOT_PASSED_ON = new Set([
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_LAUNCHED_BY_SESSION_IDS',
  'CLAUDE_CODE_SSE_PORT',
]);

function environment(env) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (!NOT_PASSED_ON.has(key.toUpperCase())) out[key] = value;
  }
  out.DISABLE_AUTOUPDATER = '1';
  return out;
}

// Is this folder (a session's cwd) the one the run happens in?
function isRunDir(cwd, dir, platform) {
  if (typeof cwd !== 'string' || !cwd || !dir) return false;
  const p = pathFor(platform);
  const norm = (v) => {
    const full = p.resolve(v).replace(/[\\/]+$/, '');
    return platform === 'win32' ? full.replace(/\//g, '\\').toLowerCase() : full;
  };
  return norm(cwd) === norm(dir);
}

// Start it and wait. Resolves with how it ended, in a few words for the log;
// never rejects. Nothing it prints is read: what matters is what it leaves in
// Claude Code's own files.
function run(l, { cwd, env, timeoutMs = TIMEOUT_MS }) {
  return new Promise((resolve) => {
    let done = false;
    let timer = null;
    const finish = (how) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(how);
    };
    let child;
    try {
      fs.mkdirSync(cwd, { recursive: true });
      child = spawn(l.file, l.args, {
        cwd,
        env: environment(env),
        windowsHide: true,
        windowsVerbatimArguments: Boolean(l.verbatim),
        stdio: 'ignore',
      });
    } catch (err) {
      finish(`it could not be started: ${err.message}`);
      return;
    }
    timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      finish(`it did not finish in ${Math.round(timeoutMs / 1000)} s`);
    }, timeoutMs);
    child.on('error', (err) => finish(`it could not be started: ${err.message}`));
    child.on('close', (code, signal) => finish(code === null ? `ended by ${signal}` : `exit code ${code}`));
  });
}

module.exports = { DIR, ARGS, TIMEOUT_MS, candidates, launcher, find, environment, isRunDir, run };
