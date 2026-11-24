// The status line wrapper, run for real: through Git Bash and through
// PowerShell, the two ways Claude Code runs a status line command on Windows.
// Whatever the user's own status line prints must come out unchanged, its
// exit code with it, and the session data must reach the widget byte for
// byte. Windows only; elsewhere there is no PowerShell 5.1 or Git Bash to run
// it under.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const sl = require('../lib/statusline');

const WINDOWS = process.platform === 'win32';
const fwd = (p) => p.replace(/\\/g, '/');

function findGitBash() {
  const candidates = [
    process.env.CLAUDE_CODE_GIT_BASH_PATH,
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe'),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'),
  ];
  return candidates.find((c) => c && fs.existsSync(c)) || null;
}

// run a command line the way Claude Code would, with data on stdin
function run(file, args, input, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => err.push(c));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out: Buffer.concat(out).toString('utf8'), err: Buffer.concat(err).toString('utf8') }));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

test('the wrapper passes the status line through and feeds the widget', { skip: !WINDOWS && 'Windows only' }, async (t) => {
  // a folder with a space in its name, like many a user profile
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawd wrap '));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // the user's own status line: says who and where, in more than ASCII
  const script = path.join(dir, 'their status.js');
  fs.writeFileSync(
    script,
    `let s = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (s += c));
process.stdin.on('end', () => {
  const d = JSON.parse(s);
  process.stdout.write('[' + d.model.display_name + '] ' + d.session_name + ' \\u00b7 ' + d.workspace.current_dir + '\\n');
  process.exit(Number(d.exit || 0));
});
`
  );
  const original = { type: 'command', command: `node "${fwd(script)}"`, padding: 1 };

  // the widget's listener
  const got = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      got.push({ url: req.url, method: req.method, body: Buffer.concat(chunks) });
      res.statusCode = 204;
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const port = server.address().port;

  for (const file of sl.wrapperFiles(original, port)) fs.writeFileSync(path.join(dir, file.name), sl.encode(file));
  const wrapped = sl.wrapperCommand(dir);
  const payload = (extra) =>
    Buffer.from(
      JSON.stringify(
        Object.assign(
          {
            session_id: 's1',
            session_name: 'Zoë’s café ☕',
            model: { display_name: 'Fable' },
            workspace: { current_dir: 'C:\\dev\\überprojekt' },
            rate_limits: { five_hour: { used_percentage: 23.5, resets_at: 1738425600 } },
          },
          extra
        )
      ),
      'utf8'
    );
  const arrived = async (n) => {
    for (let i = 0; i < 60 && got.length < n; i += 1) await new Promise((r) => setTimeout(r, 100));
    return got.length;
  };

  const bash = findGitBash();
  const shells = [
    { name: 'PowerShell', tag: 'powershell|', via: (cmd) => ['powershell.exe', ['-NoProfile', '-Command', cmd]] },
    bash && { name: 'Git Bash', tag: 'bash|', via: (cmd) => [bash, ['-c', cmd]] },
  ].filter(Boolean);
  if (!bash) t.diagnostic('Git Bash not found: tested through PowerShell only');

  for (const shell of shells) {
    await t.test(`through ${shell.name}`, async () => {
      got.length = 0;
      try {
        fs.unlinkSync(path.join(dir, sl.FILES.shell));
      } catch {}
      const input = payload();
      const plain = await run(...shell.via(original.command), input, dir);
      assert.equal(plain.code, 0, `their status line alone: ${plain.err}`);
      assert.match(plain.out, /^\[Fable\] Zoë’s café ☕ · C:\\dev\\überprojekt\r?\n$/);

      const viaWrapper = await run(...shell.via(wrapped), input, dir);
      assert.equal(viaWrapper.code, 0, viaWrapper.err);
      assert.equal(viaWrapper.out, plain.out, `the wrapper must not change what the status line prints (stderr: ${viaWrapper.err})`);

      assert.equal(await arrived(1), 1, 'the widget heard from it once');
      assert.equal(got[0].method, 'POST');
      assert.equal(got[0].url, '/claude-stoplight/statusline');
      assert.ok(got[0].body.equals(input), 'the session data arrives byte for byte');

      // it noticed which shell it was run from, and will use it again
      const remembered = fs.readFileSync(path.join(dir, sl.FILES.shell), 'utf8').replace(/^\uFEFF/, '').trim();
      assert.ok(remembered.startsWith(shell.tag), remembered);
      assert.ok(fs.existsSync(remembered.slice(shell.tag.length)), `not a file: ${remembered}`);
      const second = await run(...shell.via(wrapped), input, dir);
      assert.equal(second.out, plain.out);

      // their exit code is theirs to give
      const failing = await run(...shell.via(wrapped), payload({ exit: 3 }), dir);
      assert.equal(failing.code, 3);
    });
  }

  await t.test('as the widget tries it before installing', async () => {
    got.length = 0;
    try {
      fs.unlinkSync(path.join(dir, sl.FILES.shell));
    } catch {}
    const input = payload();
    const direct = await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(dir, sl.FILES.wrapper)], input, os.homedir());
    assert.equal(direct.code, 0, direct.err);
    assert.match(direct.out, /^\[Fable\] Zoë’s café ☕ · /, direct.err);
    assert.equal(await arrived(1), 1);
    // nothing but a parent shell is worth remembering, and here there was none
    assert.ok(!fs.existsSync(path.join(dir, sl.FILES.shell)));
    assert.ok(got[0].body.equals(input));
  });

  await t.test('with the widget not running, their status line is unaffected', async () => {
    await new Promise((resolve) => server.close(resolve));
    const [file, args] = shells[shells.length - 1].via(wrapped);
    const started = Date.now();
    const res = await run(file, args, payload(), dir);
    assert.equal(res.code, 0, res.err);
    assert.match(res.out, /^\[Fable\] Zoë’s café ☕ · /, res.err);
    assert.ok(Date.now() - started < 15000);
  });
});

test('the wrapper script parses as PowerShell', { skip: !WINDOWS && 'Windows only' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawd parse '));
  try {
    const file = path.join(dir, 'statusline.ps1');
    fs.writeFileSync(file, sl.encode(sl.wrapperFiles({ type: 'command', command: 'echo hi' }, 47615)[0]));
    const check =
      "$errors = $null; $null = [System.Management.Automation.Language.Parser]::ParseFile($env:CLAWD_PS1, [ref]$null, [ref]$errors); " +
      'if ($errors.Count) { $errors | ForEach-Object { Write-Output $_.ToString() }; exit 1 }';
    const res = spawnSync('powershell.exe', ['-NoProfile', '-Command', check], {
      env: Object.assign({}, process.env, { CLAWD_PS1: file }),
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(res.status, 0, res.stdout + res.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
