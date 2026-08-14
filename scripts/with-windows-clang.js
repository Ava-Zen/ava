/**
 * Windows ARM64 rustls/ring compiles C with Clang, not MSVC cl.exe.
 * This prepends a local LLVM install so `tauri dev/build` works in a
 * normal PowerShell that has never seen vcvars or LLVM on PATH.
 *
 * On Windows, spreading `process.env` keeps the original `Path` key.
 * Assigning `env.PATH` then creates a second variable that can hide cargo
 * from the child. Keep a single path value.
 */
const { spawn } = require('node:child_process');
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
let nextPath = readPath(env);
nextPath = prependPath(nextPath, localBin);

if (process.platform === 'win32') {
  const home = os.homedir();
  nextPath = prependPath(nextPath, path.join(home, '.cargo', 'bin'));
  const llvmBin = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'LLVM', 'bin');
  nextPath = prependPath(nextPath, llvmBin);
  if (hasClang(nextPath) && !env.CC) env.CC = 'clang';
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
