// Reads the report of a scripted run (CLAWD_SMOKE, see lib/smoke.js) and exits
// non-zero if the run failed, never finished, or left the status line in a
// state other than the one expected.
//   node scripts/check-smoke.js <folder> [plain|wrap|kept|none]
const fs = require('fs');
const path = require('path');

const [dir, expectStatusLine] = process.argv.slice(2);
if (!dir) {
  console.error('usage: node scripts/check-smoke.js <folder> [plain|wrap|kept|none]');
  process.exit(2);
}

let report;
try {
  report = JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8'));
} catch (err) {
  console.error(`smoke: no report in ${dir} (${err.message}). The app did not finish its run.`);
  process.exit(1);
}

const failures = report.failures.slice();
const extra = report.extra || {};
if (expectStatusLine) {
  const sl = extra.statusLine;
  const command = sl && typeof sl.command === 'string' ? sl.command.replace(/\\/g, '/') : '';
  const is =
    !command.includes('claude-stoplight/statusline')
      ? extra.statusLineState === 'kept'
        ? 'kept'
        : 'none'
      : command.includes('/statusline.ps1')
        ? 'wrap'
        : 'plain';
  if (is !== expectStatusLine) {
    failures.push(`status line: expected ${expectStatusLine}, found ${is} (${JSON.stringify(sl)}, state ${extra.statusLineState})`);
  }
  if (!extra.hooksInstalled) failures.push('the hooks were not installed');
}

for (const step of report.steps) {
  const p = step.page;
  console.log(`${step.name}: ${p.classes.join(' ')} | pill ${JSON.stringify(p.pill[0] || '')} | rows ${p.rows.length} | usage ${p.legend.length} | corner ${step.main.corner}`);
}
console.log(`platform ${extra.platform}, status line ${extra.statusLineState || 'none'}`);
if (failures.length) {
  console.error(`smoke: ${failures.length} check(s) failed`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('smoke: every check held');
