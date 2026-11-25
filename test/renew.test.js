const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const renew = require('../lib/renew');

test('the run is /usage, non-interactive, with none of the user\'s settings, MCP servers or history', () => {
  assert.deepEqual(renew.ARGS, ['-p', '/usage', '--setting-sources', 'local', '--strict-mcp-config', '--no-session-persistence']);
  // nothing in it needs quoting for cmd.exe, which launcher() relies on
  for (const arg of renew.ARGS) assert.match(arg, /^[A-Za-z/-]+$/);
});

test('Claude Code is looked for where its installer puts it, then along PATH', () => {
  const win = renew.candidates(
    { USERPROFILE: 'C:\\Users\\Al', Path: 'C:\\Windows\\System32;"C:\\Program Files\\nodejs";;relative\\bin;C:\\Users\\Al\\AppData\\Roaming\\npm;c:\\users\\al\\.local\\bin' },
    'win32'
  );
  assert.deepEqual(win, [
    'C:\\Users\\Al\\.local\\bin\\claude.exe',
    'C:\\Users\\Al\\.local\\bin\\claude.cmd',
    'C:\\Windows\\System32\\claude.exe',
    'C:\\Windows\\System32\\claude.cmd',
    'C:\\Program Files\\nodejs\\claude.exe',
    'C:\\Program Files\\nodejs\\claude.cmd',
    'C:\\Users\\Al\\AppData\\Roaming\\npm\\claude.exe',
    'C:\\Users\\Al\\AppData\\Roaming\\npm\\claude.cmd',
  ]);
  assert.deepEqual(renew.candidates({ HOME: '/home/al', PATH: '/usr/bin::bin:/opt/x/bin' }, 'linux'), [
    '/home/al/.local/bin/claude',
    '/usr/bin/claude',
    '/opt/x/bin/claude',
  ]);
  assert.deepEqual(renew.candidates({}, 'win32'), []);
});

test('the first one that exists is the one that is run', () => {
  const env = { USERPROFILE: 'C:\\Users\\Al', PATH: 'C:\\Users\\Al\\AppData\\Roaming\\npm', ComSpec: 'C:\\Windows\\System32\\cmd.exe' };
  const exe = renew.find(env, 'win32', (f) => f.endsWith('.local\\bin\\claude.exe') || f.endsWith('npm\\claude.cmd'));
  assert.deepEqual(exe, { file: 'C:\\Users\\Al\\.local\\bin\\claude.exe', args: renew.ARGS, verbatim: false, found: 'C:\\Users\\Al\\.local\\bin\\claude.exe' });
  assert.equal(renew.find(env, 'win32', () => false), null);

  // an npm install is a .cmd, which only cmd.exe can start: one quoted command line
  const cmd = renew.find(env, 'win32', (f) => f.endsWith('npm\\claude.cmd'));
  assert.deepEqual(cmd, {
    file: 'C:\\Windows\\System32\\cmd.exe',
    args: ['/d', '/s', '/c', '""C:\\Users\\Al\\AppData\\Roaming\\npm\\claude.cmd" -p /usage --setting-sources local --strict-mcp-config --no-session-persistence"'],
    verbatim: true,
    found: 'C:\\Users\\Al\\AppData\\Roaming\\npm\\claude.cmd',
  });
  // a path cmd.exe would read into is not run, and the next one is looked at
  const odd = { USERPROFILE: 'C:\\Users\\50%off', PATH: 'C:\\tools' };
  assert.equal(renew.find(odd, 'win32', (f) => f.endsWith('.cmd')).found, 'C:\\tools\\claude.cmd');
  assert.equal(renew.launcher('C:\\Users\\50%off\\claude.cmd', 'win32', odd), null);
  assert.equal(renew.launcher('C:\\Users\\50%off\\claude.exe', 'win32', odd).file, 'C:\\Users\\50%off\\claude.exe');
});

test('the run does not inherit another Claude Code session\'s identity, and does not update Claude Code', () => {
  const env = renew.environment({
    Path: 'C:\\x',
    CLAUDE_CONFIG_DIR: 'D:\\claude',
    CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Git\\bin\\bash.exe',
    CLAUDECODE: '1',
    claude_code_entrypoint: 'cli',
    CLAUDE_CODE_SESSION_ID: 'abc',
    CLAUDE_CODE_CHILD_SESSION: '1',
  });
  assert.deepEqual(env, { Path: 'C:\\x', CLAUDE_CONFIG_DIR: 'D:\\claude', CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Git\\bin\\bash.exe', DISABLE_AUTOUPDATER: '1' });
});

test('a session in the run\'s folder is the run, however the folder is spelled', () => {
  const dir = 'C:\\Users\\Al\\.claude-stoplight\\usage-renewal';
  assert.equal(renew.isRunDir('C:\\Users\\Al\\.claude-stoplight\\usage-renewal', dir, 'win32'), true);
  assert.equal(renew.isRunDir('c:/users/al/.claude-stoplight/usage-renewal/', dir, 'win32'), true);
  assert.equal(renew.isRunDir('C:\\Users\\Al\\.claude-stoplight', dir, 'win32'), false);
  assert.equal(renew.isRunDir('C:\\Users\\Al\\.claude-stoplight\\usage-renewal\\sub', dir, 'win32'), false);
  assert.equal(renew.isRunDir('/home/al/.claude-stoplight/usage-renewal', '/home/al/.claude-stoplight/usage-renewal', 'linux'), true);
  assert.equal(renew.isRunDir('/home/al/.claude-stoplight/Usage-Renewal', '/home/al/.claude-stoplight/usage-renewal', 'linux'), false);
  for (const cwd of [null, undefined, '', 7]) assert.equal(renew.isRunDir(cwd, dir, 'win32'), false);
});

// A stand-in for Claude Code: a script that records how it was started.
function standIn(dir, body) {
  const script = path.join(dir, 'stand-in.js');
  fs.writeFileSync(script, body);
  return { file: process.execPath, args: [script, ...renew.ARGS], verbatim: false };
}

test('the run happens in its own folder, is waited for, and says how it ended', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawd-renew-'));
  try {
    const cwd = path.join(dir, 'made', 'for', 'it');
    const out = path.join(dir, 'seen.json');
    const l = standIn(
      dir,
      `require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2), updater: process.env.DISABLE_AUTOUPDATER, inside: process.env.CLAUDECODE || null }));`
    );
    const how = await renew.run(l, { cwd, env: Object.assign({}, process.env, { CLAUDECODE: '1' }) });
    assert.equal(how, 'exit code 0');
    const seen = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(fs.realpathSync(seen.cwd), fs.realpathSync(cwd));
    assert.deepEqual(seen.args, renew.ARGS);
    assert.equal(seen.updater, '1');
    assert.equal(seen.inside, null);

    assert.equal(await renew.run(standIn(dir, 'process.exit(3);'), { cwd, env: process.env }), 'exit code 3');
    // one that hangs is stopped, and one that is not there is reported, not thrown
    const hung = await renew.run(standIn(dir, 'setInterval(() => {}, 1000);'), { cwd, env: process.env, timeoutMs: 400 });
    assert.equal(hung, 'it did not finish in 0 s');
    const missing = await renew.run({ file: path.join(dir, 'no-such-program'), args: [], verbatim: false }, { cwd, env: process.env });
    assert.match(missing, /^it could not be started: /);
  } finally {
    // the run that was stopped can still be holding its folder for a moment
    // (Windows refuses to remove a live process's working directory)
    for (let tries = 0; ; tries += 1) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        break;
      } catch (err) {
        if (tries >= 40) throw err;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }
});
