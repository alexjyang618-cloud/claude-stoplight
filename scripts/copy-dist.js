// electron-builder can't run its freshly compiled NSIS helpers inside a
// OneDrive-synced folder (spawn UNKNOWN), and the same failure started
// appearing under %TEMP%, so builds go to the app's own data folder in the
// user profile and the shareable artifacts are copied back here afterwards.
// Both folders are kept to the current version only — older installers are
// removed so dist/ always holds exactly one build.
const fs = require('fs');
const os = require('os');
const path = require('path');

const { version } = require('../package.json');
const src = path.join(os.homedir(), '.claude-stoplight', 'build');
const dest = path.join(__dirname, '..', 'dist');

// The installer is named with dashes because GitHub replaces a space in a
// release file's name, and latest.yml has to name the file as GitHub serves
// it. Installers from older builds, named with spaces, still count as stale.
const installer = `Clawd-Setup-${version}.exe`;
const isInstaller = (name) => /^Clawd[ -]Setup[ -].*\.exe(\.blockmap)?$/.test(name);
const isCurrent = (name) => [installer, `${installer}.blockmap`, 'latest.yml'].includes(name);

fs.mkdirSync(dest, { recursive: true });
for (const name of fs.readdirSync(src)) {
  if (isCurrent(name)) {
    fs.copyFileSync(path.join(src, name), path.join(dest, name));
    console.log(`copied ${name} -> dist/`);
  }
}
for (const dir of [dest, src]) {
  for (const name of fs.readdirSync(dir)) {
    if (isInstaller(name) && !isCurrent(name)) {
      fs.unlinkSync(path.join(dir, name));
      console.log(`removed stale ${path.join(dir, name)}`);
    }
  }
}
