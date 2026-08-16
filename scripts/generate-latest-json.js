#!/usr/bin/env node
/**
 * Builds Tauri's static updater manifest (latest.json) from signed release
 * artifacts so GitHub Releases can serve desktop updates.
 *
 * Usage:
 *   node scripts/generate-latest-json.js \
 *     --dir artifacts \
 *     --version 0.1.12 \
 *     --repo Ava-Zen/ava \
 *     --out artifacts/latest.json
 */
const fs = require('fs');
const path = require('path');

const UPDATER_NOTES = 'A new version of Ava is ready. See the GitHub release for details.';

function parseArgs(argv) {
  const args = { dir: 'artifacts', version: '', repo: 'Ava-Zen/ava', out: '', notes: UPDATER_NOTES };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--dir') args.dir = value;
    else if (key === '--version') args.version = value;
    else if (key === '--repo') args.repo = value;
    else if (key === '--out') args.out = value;
    else if (key === '--notes') args.notes = value;
    else continue;
    i++;
  }
  return args;
}

function detectArch(filename) {
  if (/aarch64|arm64/i.test(filename)) return 'aarch64';
  if (/armv7|armhf/i.test(filename)) return 'armv7';
  if (/(?:^|[^a-z])i686(?:[^a-z]|$)/i.test(filename)) return 'i686';
  return 'x86_64';
}

function classifyArtifact(filename) {
  if (/\.sig$/i.test(filename)) return null;

  if (/setup\.exe$/i.test(filename)) {
    return { keys: [`windows-${detectArch(filename)}`], priority: 3 };
  }
  if (/\.msi$/i.test(filename)) {
    return { keys: [`windows-${detectArch(filename)}`], priority: 2 };
  }
  if (/\.appimage$/i.test(filename)) {
    return { keys: [`linux-${detectArch(filename)}`], priority: 3 };
  }
  if (/\.app\.tar\.gz$/i.test(filename)) {
    // Universal (or single-arch) macOS updater archive.
    return { keys: ['darwin-x86_64', 'darwin-aarch64'], priority: 3 };
  }
  return null;
}

function readSignature(dir, filename) {
  const sigPath = path.join(dir, `${filename}.sig`);
  if (!fs.existsSync(sigPath)) return '';
  return fs.readFileSync(sigPath, 'utf8').trim();
}

function downloadUrl(repo, version, filename) {
  const tag = version.startsWith('v') ? version : `v${version}`;
  return `https://github.com/${repo}/releases/download/${tag}/${filename}`;
}

function collectFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(name => fs.statSync(path.join(dir, name)).isFile());
}

function buildLatestJson({ files, dir, version, repo, notes, pubDate }) {
  const best = new Map();
  for (const name of files) {
    const classified = classifyArtifact(name);
    if (!classified) continue;
    const signature = readSignature(dir, name);
    if (!signature) continue;
    for (const key of classified.keys) {
      const previous = best.get(key);
      if (!previous || classified.priority > previous.priority) {
        best.set(key, {
          signature,
          url: downloadUrl(repo, version, name),
        });
      }
    }
  }

  return {
    version: String(version).replace(/^v/, ''),
    notes: notes || UPDATER_NOTES,
    pub_date: pubDate || new Date().toISOString(),
    platforms: Object.fromEntries([...best.entries()].sort(([a], [b]) => a.localeCompare(b))),
  };
}

function writeLatestJson(options) {
  const version = String(options.version || '').replace(/^v/, '');
  if (!version) throw new Error('Missing --version');
  const files = collectFiles(options.dir);
  const manifest = buildLatestJson({
    files,
    dir: options.dir,
    version,
    repo: options.repo,
    notes: options.notes,
    pubDate: options.pubDate,
  });
  if (!Object.keys(manifest.platforms).length) {
    throw new Error(`No signed updater artifacts found in ${options.dir}`);
  }
  const out = options.out || path.join(options.dir, 'latest.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n');
  return { out, manifest };
}

function selfTest() {
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ava-latest-'));
  const names = [
    'Ava_0.1.13_x64-setup.exe',
    'Ava_0.1.13_x64-setup.exe.sig',
    'Ava_0.1.13_x64_en-US.msi',
    'Ava_0.1.13_x64_en-US.msi.sig',
    'Ava_0.1.13_arm64-setup.exe',
    'Ava_0.1.13_arm64-setup.exe.sig',
    'Ava.app.tar.gz',
    'Ava.app.tar.gz.sig',
    'Ava_0.1.13_amd64.AppImage',
    'Ava_0.1.13_amd64.AppImage.sig',
  ];
  for (const name of names) {
    fs.writeFileSync(path.join(tmp, name), name.endsWith('.sig') ? `sig-for-${name.replace(/\.sig$/, '')}` : 'bin');
  }

  const { manifest } = writeLatestJson({
    dir: tmp,
    version: 'v0.1.13',
    repo: 'Ava-Zen/ava',
    out: path.join(tmp, 'latest.json'),
    notes: 'notes',
    pubDate: '2026-08-16T00:00:00.000Z',
  });

  const expectedPlatforms = {
    'windows-x86_64': {
      signature: 'sig-for-Ava_0.1.13_x64-setup.exe',
      url: 'https://github.com/Ava-Zen/ava/releases/download/v0.1.13/Ava_0.1.13_x64-setup.exe',
    },
    'windows-aarch64': {
      signature: 'sig-for-Ava_0.1.13_arm64-setup.exe',
      url: 'https://github.com/Ava-Zen/ava/releases/download/v0.1.13/Ava_0.1.13_arm64-setup.exe',
    },
    'darwin-x86_64': {
      signature: 'sig-for-Ava.app.tar.gz',
      url: 'https://github.com/Ava-Zen/ava/releases/download/v0.1.13/Ava.app.tar.gz',
    },
    'darwin-aarch64': {
      signature: 'sig-for-Ava.app.tar.gz',
      url: 'https://github.com/Ava-Zen/ava/releases/download/v0.1.13/Ava.app.tar.gz',
    },
    'linux-x86_64': {
      signature: 'sig-for-Ava_0.1.13_amd64.AppImage',
      url: 'https://github.com/Ava-Zen/ava/releases/download/v0.1.13/Ava_0.1.13_amd64.AppImage',
    },
  };

  if (manifest.version !== '0.1.13' || manifest.notes !== 'notes' || manifest.pub_date !== '2026-08-16T00:00:00.000Z') {
    throw new Error(`self-test metadata mismatch:\n${JSON.stringify(manifest, null, 2)}`);
  }
  const actualKeys = Object.keys(manifest.platforms).sort();
  const expectedKeys = Object.keys(expectedPlatforms).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error(`self-test platform keys mismatch: ${actualKeys.join(', ')}`);
  }
  for (const key of expectedKeys) {
    if (JSON.stringify(manifest.platforms[key]) !== JSON.stringify(expectedPlatforms[key])) {
      throw new Error(`self-test mismatch for ${key}:\n${JSON.stringify(manifest.platforms[key], null, 2)}`);
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('generate-latest-json self-test passed');
}

if (require.main === module) {
  if (process.argv.includes('--self-test')) {
    selfTest();
  } else {
    const result = writeLatestJson(parseArgs(process.argv.slice(2)));
    console.log(`Wrote ${result.out}`);
    console.log(JSON.stringify(result.manifest, null, 2));
  }
}

module.exports = {
  buildLatestJson,
  classifyArtifact,
  detectArch,
  downloadUrl,
  writeLatestJson,
};
