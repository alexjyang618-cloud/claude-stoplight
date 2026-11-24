// Publishes the build in dist/ as the GitHub release v<version>, using the
// GitHub CLI (gh). The installed app's updater reads latest.yml from the newest
// release and downloads the installer it names, so the three files have to come
// from one build and keep their names; this script refuses to publish anything
// else. Run `npm run dist` first, then commit and push: the release tag is
// created on GitHub at that pushed commit.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const { version, build } = require('../package.json');
const repo = `${build.publish.owner}/${build.publish.repo}`;
const tag = `v${version}`;
const dist = path.join(root, 'dist');
const installer = `Clawd-Setup-${version}.exe`;
const files = [installer, `${installer}.blockmap`, 'latest.yml'].map((name) => path.join(dist, name));

function fail(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}

function run(cmd, args) {
  return execFileSync(cmd, args, { cwd: root, encoding: 'utf8' }).trim();
}

// gh from PATH, or from its default install folder when this shell was opened
// before gh was installed.
function findGh() {
  const candidates = ['gh'];
  if (process.env.ProgramFiles) {
    candidates.push(path.join(process.env.ProgramFiles, 'GitHub CLI', 'gh.exe'));
  }
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['--version'], { stdio: 'ignore' });
      return candidate;
    } catch {
      // try the next one
    }
  }
  return fail('the GitHub CLI (gh) is not installed. Get it from https://cli.github.com and run "gh auth login".');
}

for (const file of files) {
  if (!fs.existsSync(file)) {
    fail(`${path.relative(root, file)} is missing. Run "npm run dist" first.`);
  }
}

// latest.yml must describe exactly this installer: every name and checksum in
// it is compared with the file about to be uploaded.
const manifest = fs.readFileSync(path.join(dist, 'latest.yml'), 'utf8');
const sha512 = crypto.createHash('sha512').update(fs.readFileSync(files[0])).digest('base64');
const describes = (key, want) => {
  const found = [...manifest.matchAll(new RegExp(`^[ -]*${key}:\\s*(.+?)\\s*$`, 'gm'))].map((m) => m[1]);
  return found.length > 0 && found.every((value) => value === want);
};
if (
  !describes('version', version) ||
  !describes('url', installer) ||
  !describes('path', installer) ||
  !describes('sha512', sha512)
) {
  fail(`dist/latest.yml does not match dist/${installer}. Run "npm run dist" again.`);
}

if (run('git', ['status', '--porcelain'])) {
  fail('there are uncommitted changes. Commit and push them first, so the release tag matches the build.');
}
// (a GitHub Actions checkout is a detached HEAD; the workflow names the branch)
const branch = process.env.GITHUB_REF_NAME || run('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
const commit = run('git', ['rev-parse', 'HEAD']);
const refs = run('git', ['ls-remote', `https://github.com/${repo}.git`, `refs/heads/${branch}`, `refs/tags/${tag}`]);
if (/\srefs\/tags\//.test(refs)) {
  fail(`${tag} already exists on GitHub. Raise the version in package.json and build again.`);
}
if (!refs.startsWith(commit)) {
  fail(`the latest commit on ${branch} is not on GitHub (${repo}) yet. Run "git push" first.`);
}

// The release notes are this version's section of CHANGELOG.md, when it has
// one; otherwise GitHub writes them from the commits.
function changelogNotes() {
  let text;
  try {
    text = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  } catch {
    return null;
  }
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith('## ') && line.includes(version));
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  const body = (end < 0 ? rest : rest.slice(0, end)).join('\n').trim();
  return body || null;
}

const gh = findGh();
const notes = changelogNotes();
const notesFile = path.join(dist, 'release-notes.md');
if (notes) fs.writeFileSync(notesFile, `${notes}\n`);
execFileSync(
  gh,
  [
    'release',
    'create',
    tag,
    ...files,
    '--repo',
    repo,
    '--target',
    commit,
    '--title',
    `Clawd ${version}`,
    ...(notes ? ['--notes-file', notesFile] : ['--generate-notes']),
  ],
  { cwd: root, stdio: 'inherit' }
);
