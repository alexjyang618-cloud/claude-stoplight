const test = require('node:test');
const assert = require('node:assert/strict');
const sl = require('../lib/statusline');

const DIR = 'C:\\Users\\Alex Yang\\.claude-stoplight';
const ctx = (extra) => Object.assign({ port: 47615, dir: DIR, saved: null }, extra);

test('with no status line, ours is a bare curl call that prints nothing', () => {
  const plan = sl.plan({}, ctx());
  assert.equal(plan.kind, 'plain');
  assert.equal(plan.current, false);
  assert.equal(plan.original, null);
  assert.deepEqual(plan.statusLine, {
    type: 'command',
    command: 'curl.exe -s -o NUL -m 1 -X POST --data-binary "@-" http://127.0.0.1:47615/claude-stoplight/statusline ; exit 0',
  });
  assert.ok(sl.isOurs(plan.statusLine));
  assert.ok(!sl.isWrapper(plan.statusLine));
});

test('ours, already in place, is left alone; a port change rewrites it', () => {
  const settings = { statusLine: sl.plan({}, ctx()).statusLine };
  assert.equal(sl.plan(settings, ctx()).current, true);
  const moved = sl.plan(settings, ctx({ port: 5000 }));
  assert.equal(moved.kind, 'plain');
  assert.equal(moved.current, false);
  assert.match(moved.statusLine.command, /127\.0\.0\.1:5000\//);
});

test('a status line of the user\'s own is kept behind the wrapper, its other keys untouched', () => {
  const theirs = { type: 'command', command: 'bash ~/.claude/statusline.sh', padding: 2, refreshInterval: 5 };
  const plan = sl.plan({ statusLine: theirs }, ctx());
  assert.equal(plan.kind, 'wrap');
  assert.equal(plan.current, false);
  assert.deepEqual(plan.original, theirs);
  assert.notEqual(plan.original, theirs); // a copy
  assert.deepEqual(plan.statusLine, {
    type: 'command',
    command: 'powershell -NoProfile -ExecutionPolicy Bypass -File "C:/Users/Alex Yang/.claude-stoplight/statusline.ps1"',
    padding: 2,
    refreshInterval: 5,
  });
  assert.ok(sl.isOurs(plan.statusLine));
  assert.ok(sl.isWrapper(plan.statusLine));
});

test('the wrapper, already in place, is recognised and rebuilt from the saved original', () => {
  const theirs = { type: 'command', command: 'npx ccstatusline' };
  const wrapped = sl.plan({ statusLine: theirs }, ctx()).statusLine;
  const again = sl.plan({ statusLine: wrapped }, ctx({ saved: theirs }));
  assert.equal(again.kind, 'wrap');
  assert.equal(again.current, true);
  assert.deepEqual(again.original, theirs);
  // without the original on record there is nothing to rebuild it from
  assert.equal(sl.plan({ statusLine: wrapped }, ctx()).original, null);
});

test('an entry that is not a command is left alone', () => {
  for (const odd of [{ type: 'other' }, { type: 'command', command: '   ' }, 'text', 7]) {
    const plan = sl.plan({ statusLine: odd }, ctx());
    assert.equal(plan.kind, 'skip');
    assert.equal(plan.current, true);
  }
});

test('removing ours deletes the bare call, and puts a wrapped original back exactly', () => {
  const plain = { hooks: {}, statusLine: sl.plan({}, ctx()).statusLine };
  assert.equal(sl.remove(plain, null), true);
  assert.deepEqual(plain, { hooks: {} });

  const theirs = { type: 'command', command: 'bash ~/.claude/statusline.sh', padding: 2 };
  const wrapped = { statusLine: sl.plan({ statusLine: theirs }, ctx()).statusLine };
  assert.equal(sl.remove(wrapped, theirs), true);
  assert.deepEqual(wrapped, { statusLine: theirs });

  // someone else's is never touched
  const other = { statusLine: { type: 'command', command: 'npx ccstatusline' } };
  assert.equal(sl.remove(other, theirs), false);
  assert.deepEqual(other, { statusLine: { type: 'command', command: 'npx ccstatusline' } });
  assert.equal(sl.remove({}, null), false);
  assert.equal(sl.remove(null, null), false);
});

test('the wrapper script names the port and its files, and no template is left unfilled', () => {
  const text = sl.wrapperScript(47615);
  assert.match(text, /http:\/\/127\.0\.0\.1:47615\/claude-stoplight\/statusline'/);
  assert.match(text, /statusline-original\.sh/);
  assert.match(text, /statusline-original\.ps1/);
  assert.match(text, /statusline-shell\.txt/);
  assert.ok(!/undefined|\[object/.test(text));
  // PowerShell's own ${env:...} survives the JavaScript template
  assert.match(text, /\$\{env:ProgramFiles\(x86\)\}/);
  // and its backslashes: a path separator, and the regex for one
  assert.match(text, /'Git\\bin\\bash\.exe'/);
  assert.match(text, /-replace '\\\\', '\/'/);
  // Windows PowerShell 5.1 has to run it
  assert.ok(!/\?\?|\?\./.test(text));
  // in PowerShell the comma binds tighter than +, so 'a' + $b, $c is 'a' + ($b, $c):
  // every pair this script returns has its first half in brackets
  for (const pair of text.match(/return @\(.*\)/g)) assert.match(pair, /^return @\(\(.+\), \$(true|false)\)$|^return @\('[^'+]+', \$(true|false)\)$/);
});

test('the files beside the wrapper: the original command for each shell, encoded for it', () => {
  const files = sl.wrapperFiles({ type: 'command', command: 'node "C:/Übung/status.js"\r\n' }, 47615);
  assert.deepEqual(files.map((f) => f.name), ['statusline.ps1', 'statusline-original.sh', 'statusline-original.ps1']);
  const [wrapper, sh, ps1] = files.map(sl.encode);
  const BOM = [0xef, 0xbb, 0xbf];
  assert.deepEqual([...wrapper.subarray(0, 3)], BOM);
  assert.deepEqual([...ps1.subarray(0, 3)], BOM);
  assert.notDeepEqual([...sh.subarray(0, 3)], BOM); // Git Bash chokes on one
  assert.equal(sh.toString('utf8'), 'node "C:/Übung/status.js"\n');
  assert.equal(ps1.subarray(3).toString('utf8'), 'node "C:/Übung/status.js"\r\n');
  assert.ok(!wrapper.subarray(3).toString('utf8').replace(/\r\n/g, '').includes('\n')); // CRLF throughout
});

test('the trial payload carries its nonce and no usage', () => {
  const p = sl.samplePayload('abc123', 'C:\\Users\\x');
  assert.equal(p.clawd_selftest, 'abc123');
  assert.equal(p.rate_limits, undefined);
  assert.equal(p.workspace.current_dir, 'C:\\Users\\x');
});
