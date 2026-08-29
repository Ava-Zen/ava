/**
 * Detached helper: wait for Ava to exit, rebuild from her source, then start
 * the new binary. Spawned by the desktop host before it quits.
 *
 * argv: <parentPid> <sourceDir> <stateJsonPath> <originalExe>
 */
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const parentPid = Number(process.argv[2] || '0');
const source = process.argv[3];
const statePath = process.argv[4];
const originalExe = process.argv[5] || '';

const logPath = source
  ? path.join(source, '.ava-self-improve-build.log')
  : path.join(require('node:os').tmpdir(), 'ava-self-improve-build.log');

function log(line) {
  const text = `[${new Date().toISOString()}] ${line}\n`;
  try {
    fs.appendFileSync(logPath, text);
  } catch {
    // ignore
  }
  try {
    process.stderr.write(text);
  } catch {
    // ignore
  }
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  spawnSync(process.platform === 'win32' ? 'ping' : 'sleep', process.platform === 'win32' ? ['127.0.0.1', '-n', '2'] : ['0.4'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  if (ms && process.platform !== 'win32') {
    // the sleep above already waited ~0.4s
  }
}

function waitForParent(pid) {
  const deadline = Date.now() + 120000;
  while (pidAlive(pid) && Date.now() < deadline) {
    sleep(400);
  }
}

function run(command, args, cwd) {
  log(`$ ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    windowsHide: true,
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(`${command} exited ${result.status}`);
  }
}

function builtExe(root) {
  const name = process.platform === 'win32' ? 'app.exe' : 'app';
  return path.join(root, 'src-tauri', 'target', 'release', name);
}

function writeState(patch) {
  if (!statePath) return;
  let current = {};
  try {
    current = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    current = {};
  }
  const next = { ...current, ...patch };
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(next, null, 2));
}

function startExe(exe, extraArgs) {
  log(`starting ${exe}`);
  const child = spawn(exe, extraArgs || [], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}

function startOriginal(reason) {
  log(reason);
  writeState({ liveExe: '', liveOk: false });
  if (originalExe && fs.existsSync(originalExe)) {
    startExe(originalExe, ['--factory']);
  }
}

if (!source || !fs.existsSync(path.join(source, 'package.json'))) {
  log('Missing source tree.');
  process.exit(1);
}

log(`waiting for Ava pid ${parentPid}`);
waitForParent(parentPid);

try {
  if (!fs.existsSync(path.join(source, 'node_modules'))) {
    run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install'], source);
  }
  run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'tauri:build'], source);
  const exe = builtExe(source);
  if (!fs.existsSync(exe)) {
    throw new Error(`Built binary missing at ${exe}`);
  }
  writeState({
    liveExe: exe,
    liveOk: false,
    lastHopAt: Math.floor(Date.now() / 1000),
    originalExe: originalExe || undefined,
  });
  startExe(exe);
  log('started self-improved Ava');
} catch (error) {
  startOriginal(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
