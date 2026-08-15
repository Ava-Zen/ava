/**
 * Native crates such as rustls/ring compile C. On Windows:
 *   - ARM64 ring must use Clang, not MSVC cl.exe
 *   - Clang without the Visual Studio / Windows SDK include path
 *     fails with fatal error: 'assert.h' file not found
 *
 * This loads VsDevCmd (INCLUDE/LIB/cl.exe) so a normal PowerShell
 * session can build, and on ARM64 also prepends LLVM and sets CC=clang.
 *
 * On Windows, spreading `process.env` keeps the original `Path` key.
 * Assigning `env.PATH` then creates a second variable that can hide cargo
 * from the child. Keep a single path value.
 */
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('usage: node scripts/with-windows-clang.js <command> [args...]');
  process.exit(2);
}

const projectRoot = path.join(__dirname, '..');
const localBin = path.join(projectRoot, 'node_modules', '.bin');

function readPath(env) {
  return env.Path || env.PATH || env.path || '';
}

function writePath(env, value) {
  delete env.Path;
  delete env.PATH;
  delete env.path;
  env[process.platform === 'win32' ? 'Path' : 'PATH'] = value;
}

function prependPath(current, dir) {
  if (!dir || !fs.existsSync(dir)) return current;
  const parts = current.split(path.delimiter).filter(Boolean);
  if (parts.some((part) => path.resolve(part) === path.resolve(dir))) return current;
  return `${dir}${path.delimiter}${current}`;
}

function hasClang(envPath) {
  const exts = process.platform === 'win32' ? ['.exe', ''] : [''];
  return envPath.split(path.delimiter).some((dir) =>
    exts.some((ext) => fs.existsSync(path.join(dir, `clang${ext}`)))
  );
}

function findVsDevCmd() {
  const vswhere = path.join(
    process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
    'Microsoft Visual Studio',
    'Installer',
    'vswhere.exe',
  );
  if (!fs.existsSync(vswhere)) return null;

  const requiresList =
    process.arch === 'arm64'
      ? [
          'Microsoft.VisualStudio.Component.VC.Tools.ARM64',
          'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
        ]
      : [
          'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
          'Microsoft.VisualStudio.Component.VC.Tools.ARM64',
        ];

  for (const requires of requiresList) {
    try {
      const found = execFileSync(
        vswhere,
        [
          '-latest',
          '-products',
          '*',
          '-requires',
          requires,
          '-find',
          'Common7\\Tools\\VsDevCmd.bat',
        ],
        { encoding: 'utf8', windowsHide: true },
      ).trim();
      const first = found
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean);
      if (first && fs.existsSync(first)) return first;
    } catch {
      // try the next Visual C++ workload
    }
  }
  return null;
}

function applyVsDevCmd(env) {
  const vsDevCmd = findVsDevCmd();
  if (!vsDevCmd) {
    console.warn(
      'with-windows-clang: Visual Studio C++ tools not found; crates like ring may fail with missing headers (assert.h).',
    );
    return false;
  }

  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const result = spawnSync(
    process.env.ComSpec || 'cmd.exe',
    [
      '/d',
      '/s',
      '/c',
      `call "${vsDevCmd}" -arch=${arch} -host_arch=${arch} -no_logo && set`,
    ],
    {
      env,
      encoding: 'utf8',
      windowsHide: true,
      windowsVerbatimArguments: true,
    },
  );
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim().split(/\r?\n/)[0];
    console.warn(
      `with-windows-clang: failed to load VsDevCmd (${detail || `exit ${result.status}`}).`,
    );
    return false;
  }

  for (const line of (result.stdout || '').split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    if (!/^[A-Za-z_][A-Za-z0-9()]*$/.test(key)) continue;
    env[key] = line.slice(eq + 1);
  }
  return true;
}

function resolveCommand(command) {
  if (command === 'tauri') {
    return {
      file: process.execPath,
      argv: [require.resolve('@tauri-apps/cli/tauri.js')],
    };
  }

  if (process.platform === 'win32') {
    for (const ext of ['.cmd', '.exe', '']) {
      const candidate = path.join(localBin, `${command}${ext}`);
      if (!fs.existsSync(candidate)) continue;
      if (ext === '.cmd') {
        return {
          file: process.execPath,
          argv: [path.join(localBin, command)],
        };
      }
      return { file: candidate, argv: [] };
    }
  } else {
    const candidate = path.join(localBin, command);
    if (fs.existsSync(candidate)) {
      return { file: candidate, argv: [] };
    }
  }

  return { file: command, argv: [] };
}

const env = { ...process.env };

if (process.platform === 'win32') {
  applyVsDevCmd(env);
}

let nextPath = readPath(env);
nextPath = prependPath(nextPath, localBin);

if (process.platform === 'win32') {
  const home = os.homedir();
  nextPath = prependPath(nextPath, path.join(home, '.cargo', 'bin'));
  const llvmBin = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'LLVM', 'bin');
  nextPath = prependPath(nextPath, llvmBin);
  // ARM64 rustls/ring cannot compile its C with MSVC cl.exe.
  // On x64, leave CC unset so cc-rs uses cl.exe from VsDevCmd.
  // If the user already set CC=clang, INCLUDE from VsDevCmd still applies.
  if (process.arch === 'arm64' && hasClang(nextPath) && !env.CC) {
    env.CC = 'clang';
  }
}

writePath(env, nextPath);

const [command, ...commandArgs] = args;
const resolved = resolveCommand(command);
const child = spawn(resolved.file, [...resolved.argv, ...commandArgs], {
  env,
  stdio: 'inherit',
  windowsHide: true,
});
child.on('error', (error) => {
  console.error(error.message);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
