/**
 * Copy Ava's own source into src-tauri/resources/ava-src so a packaged
 * install can self-improve. Skips build artifacts and the copy destination.
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const dest = path.join(root, 'src-tauri', 'resources', 'ava-src');

const SKIP = new Set([
  'node_modules',
  'target',
  'dist',
  '.angular',
  '.git',
  'coverage',
  'tmp',
  'out-tsc',
  'ava-src',
  'resources',
]);

const FILES = [
  'package.json',
  'package-lock.json',
  'angular.json',
  'tsconfig.json',
  'tsconfig.app.json',
  'tsconfig.spec.json',
  'AGENTS.md',
  'LICENSE',
  '.gitignore',
];

const DIRS = ['src', 'public', 'scripts', 'src-tauri'];

const SKIP_UNDER_TAURI = new Set(['target', 'gen', 'resources']);

function shouldSkip(name, inTauri) {
  if (SKIP.has(name)) return true;
  if (inTauri && SKIP_UNDER_TAURI.has(name)) return true;
  return false;
}

function copyDir(from, to, inTauri) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.gitignore') continue;
    if (shouldSkip(entry.name, inTauri)) continue;
    const srcPath = path.join(from, entry.name);
    const dstPath = path.join(to, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, dstPath, inTauri || entry.name === 'src-tauri');
    } else {
      fs.mkdirSync(path.dirname(dstPath), { recursive: true });
      fs.copyFileSync(srcPath, dstPath);
    }
  }
}

fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });

for (const file of FILES) {
  const from = path.join(root, file);
  if (!fs.existsSync(from)) continue;
  fs.copyFileSync(from, path.join(dest, file));
}

for (const dir of DIRS) {
  const from = path.join(root, dir);
  if (!fs.existsSync(from)) continue;
  copyDir(from, path.join(dest, dir), dir === 'src-tauri');
}

const marker = {
  kind: 'ava-self-source',
  packedAt: new Date().toISOString(),
};
fs.writeFileSync(path.join(dest, '.ava-self-source.json'), JSON.stringify(marker, null, 2));
fs.writeFileSync(path.join(dest, '.gitkeep'), '# Packed by npm run pack:source before a release build.\n');

console.log('Packed Ava source to', dest);
