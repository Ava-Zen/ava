//! Ava can edit her own source, compile, and restart. The working tree lives
//! next to the install (or in a git checkout during `tauri dev`). A pristine
//! snapshot is kept so the user can undo a bad self-improvement.

use std::{
  env, fs, io,
  net::{Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream},
  path::{Path, PathBuf},
  process::{Command, Stdio},
  sync::atomic::{AtomicBool, Ordering},
  thread,
  time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

/// Angular `ng serve` port from `tauri.conf.json` `build.devUrl`.
const DEV_PORT: u16 = 4222;
const DEV_URL: &str = "http://localhost:4222/";

const SKIP_DIR_NAMES: &[&str] = &[
  "node_modules",
  "target",
  "dist",
  ".angular",
  ".git",
  "coverage",
  "tmp",
  "out-tsc",
  "ava-src",
];

const CRASH_LOOP_SECS: u64 = 20;
static ARMED: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Persist {
  #[serde(default)]
  original_exe: String,
  #[serde(default)]
  live_exe: String,
  #[serde(default)]
  last_hop_at: u64,
  #[serde(default)]
  live_ok: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolNeed {
  pub id: String,
  pub label: String,
  pub present: bool,
  pub install_url: String,
  pub install_command: String,
  pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelfImproveStatus {
  pub desktop: bool,
  pub from_checkout: bool,
  pub customized: bool,
  pub armed: bool,
  pub source_path: String,
  pub pristine_path: String,
  pub live_exe: String,
  pub original_exe: String,
  pub os: String,
  pub node: bool,
  pub npm: bool,
  pub cargo: bool,
  pub ready: bool,
  pub missing: Vec<String>,
  pub tools: Vec<ToolNeed>,
  pub grok_install_url: String,
  pub grok_install_command: String,
  pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnsureResult {
  pub path: String,
  pub from_checkout: bool,
}

fn now_secs() -> u64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_secs())
    .unwrap_or(0)
}

fn root_dir(app: &AppHandle) -> Result<PathBuf, String> {
  app
    .path()
    .app_local_data_dir()
    .map(|p| p.join("self-improve"))
    .map_err(|e| e.to_string())
}

fn state_path(app: &AppHandle) -> Result<PathBuf, String> {
  Ok(root_dir(app)?.join("state.json"))
}

fn load_state(app: &AppHandle) -> Persist {
  let Ok(path) = state_path(app) else {
    return Persist::default();
  };
  fs::read_to_string(path)
    .ok()
    .and_then(|raw| serde_json::from_str(&raw).ok())
    .unwrap_or_default()
}

fn save_state(app: &AppHandle, state: &Persist) -> Result<(), String> {
  let path = state_path(app)?;
  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
  }
  fs::write(path, serde_json::to_string_pretty(state).map_err(|e| e.to_string())?)
    .map_err(|e| e.to_string())
}

fn current_exe() -> PathBuf {
  env::current_exe().unwrap_or_default()
}

fn same_path(a: &Path, b: &Path) -> bool {
  let na = normalize_path(a);
  let nb = normalize_path(b);
  !na.as_os_str().is_empty() && na == nb
}

fn normalize_path(path: &Path) -> PathBuf {
  let mut text = path.to_string_lossy().replace('/', std::path::MAIN_SEPARATOR_STR);
  #[cfg(windows)]
  {
    const UNC: &str = r"\\?\";
    if let Some(stripped) = text.strip_prefix(UNC) {
      text = stripped.to_string();
    }
    text = text.to_ascii_lowercase();
  }
  PathBuf::from(text)
}

fn checkout_root() -> Option<PathBuf> {
  if !cfg!(debug_assertions) {
    return None;
  }
  let src_tauri = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
  let root = src_tauri.parent()?.to_path_buf();
  if root.join("package.json").is_file() && root.join("src").is_dir() && root.join("src-tauri").is_dir()
  {
    Some(root)
  } else {
    None
  }
}

fn working_source(app: &AppHandle) -> Result<PathBuf, String> {
  if let Some(root) = checkout_root() {
    return Ok(root);
  }
  Ok(root_dir(app)?.join("source"))
}

fn pristine_dir(app: &AppHandle) -> Result<PathBuf, String> {
  Ok(root_dir(app)?.join("pristine"))
}

fn has_cmd(name: &str) -> bool {
  if crate::grok::platform::which(name).is_ok() {
    return true;
  }
  known_binary(name).is_some()
}

fn known_binary(name: &str) -> Option<PathBuf> {
  let mut candidates = Vec::new();
  if let Some(home) = dirs::home_dir() {
    candidates.push(home.join(".cargo").join("bin").join(exe_name(name)));
    candidates.push(home.join(".grok").join("bin").join(exe_name(name)));
    candidates.push(home.join(".local").join("bin").join(name));
  }
  if cfg!(windows) {
    if let Ok(pf) = env::var("ProgramFiles") {
      let pf = PathBuf::from(pf);
      candidates.push(pf.join("nodejs").join(exe_name(name)));
      candidates.push(pf.join("nodejs").join(format!("{name}.cmd")));
      candidates.push(pf.join("LLVM").join("bin").join(exe_name(name)));
    }
    if let Ok(local) = env::var("LOCALAPPDATA") {
      let local = PathBuf::from(local);
      candidates.push(local.join("Programs").join("nodejs").join(exe_name(name)));
      candidates.push(local.join("Programs").join("nodejs").join(format!("{name}.cmd")));
    }
  }
  candidates.into_iter().find(|path| path.is_file())
}

fn exe_name(base: &str) -> String {
  if cfg!(windows) && !base.to_ascii_lowercase().ends_with(".exe") {
    format!("{base}.exe")
  } else {
    base.to_string()
  }
}

#[cfg(windows)]
fn hide_console(cmd: &mut Command) {
  use std::os::windows::process::CommandExt;
  const CREATE_NO_WINDOW: u32 = 0x0800_0000;
  cmd.creation_flags(CREATE_NO_WINDOW);
}

fn skip_name(name: &str) -> bool {
  SKIP_DIR_NAMES
    .iter()
    .any(|skip| name.eq_ignore_ascii_case(skip))
}

fn copy_tree(src: &Path, dst: &Path) -> Result<(), String> {
  if !src.exists() {
    return Err(format!("Missing {}", src.display()));
  }
  fs::create_dir_all(dst).map_err(|e| e.to_string())?;
  for item in fs::read_dir(src).map_err(|e| e.to_string())? {
    let item = item.map_err(|e| e.to_string())?;
    let name = item.file_name();
    let name_str = name.to_string_lossy();
    if name_str.starts_with('.') && name_str != ".gitignore" {
      continue;
    }
    if skip_name(&name_str) {
      continue;
    }
    let from = item.path();
    let to = dst.join(&name);
    let file_type = item.file_type().map_err(|e| e.to_string())?;
    if file_type.is_dir() {
      copy_tree(&from, &to)?;
    } else {
      if let Some(parent) = to.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
      }
      fs::copy(&from, &to).map_err(|e| format!("Copy {}: {e}", from.display()))?;
    }
  }
  Ok(())
}

fn restore_tree(src: &Path, dst: &Path) -> Result<(), String> {
  copy_tree(src, dst)
}

fn bundled_source(app: &AppHandle) -> Option<PathBuf> {
  let resource = app.path().resource_dir().ok()?;
  let candidates = [
    resource.join("resources").join("ava-src"),
    resource.join("ava-src"),
    resource.join("resources/ava-src"),
  ];
  candidates.into_iter().find(|path| path.join("package.json").is_file())
}

fn write_grok_mcp_config(source: &Path) -> Result<(), String> {
  let dir = source.join(".grok");
  fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
  let path = dir.join("config.toml");
  let existing = fs::read_to_string(&path).unwrap_or_default();
  if existing.contains("[mcp_servers.ava]") {
    return Ok(());
  }
  let block = "\n[mcp_servers.ava]\nurl = \"http://127.0.0.1:7456\"\nenabled = true\n";
  let mut next = existing;
  if !next.is_empty() && !next.ends_with('\n') {
    next.push('\n');
  }
  next.push_str(block);
  fs::write(path, next).map_err(|e| e.to_string())
}

fn snapshot_if_needed(app: &AppHandle, source: &Path) -> Result<(), String> {
  let pristine = pristine_dir(app)?;
  if pristine.join("package.json").is_file() {
    return Ok(());
  }
  copy_tree(source, &pristine)
}

fn extract_bundled_if_needed(app: &AppHandle) -> Result<PathBuf, String> {
  let source = working_source(app)?;
  if source.join("package.json").is_file() {
    write_grok_mcp_config(&source)?;
    snapshot_if_needed(app, &source)?;
    return Ok(source);
  }
  let bundled = bundled_source(app).ok_or_else(|| {
    "This install does not include Ava's source, so she cannot change herself.".to_string()
  })?;
  copy_tree(&bundled, &source)?;
  snapshot_if_needed(app, &source)?;
  write_grok_mcp_config(&source)?;
  Ok(source)
}

fn remember_original(app: &AppHandle) {
  let mut state = load_state(app);
  let exe = current_exe();
  if exe.as_os_str().is_empty() {
    return;
  }
  if !state.original_exe.trim().is_empty() {
    return;
  }
  if !state.live_exe.trim().is_empty() && same_path(&exe, Path::new(&state.live_exe)) {
    return;
  }
  state.original_exe = exe.to_string_lossy().into_owned();
  let _ = save_state(app, &state);
}

fn factory_requested() -> bool {
  env::args().any(|arg| {
    matches!(
      arg.as_str(),
      "--factory" | "--reset-self" | "--reset-self-improvements"
    )
  })
}

fn reset_requested() -> bool {
  env::args()
    .any(|arg| matches!(arg.as_str(), "--reset-self" | "--reset-self-improvements"))
}

fn spawn_detached(path: &Path, extra_args: &[&str]) -> Result<(), String> {
  let mut cmd = Command::new(path);
  cmd.args(extra_args);
  cmd.stdin(Stdio::null());
  cmd.stdout(Stdio::null());
  cmd.stderr(Stdio::null());
  #[cfg(windows)]
  {
    use std::os::windows::process::CommandExt;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    // Do not set CREATE_NO_WINDOW: that can leave a GUI Ava as a shell
    // with no visible window after a self-improve hop.
    cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
  }
  #[cfg(unix)]
  {
    use std::os::unix::process::CommandExt;
    cmd.process_group(0);
  }
  cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

fn live_exe_path(state: &Persist) -> Option<PathBuf> {
  let live = state.live_exe.trim();
  if live.is_empty() {
    return None;
  }
  let path = PathBuf::from(live);
  if path.is_file() {
    Some(path)
  } else {
    None
  }
}

fn looks_like_debug_target(path: &Path) -> bool {
  let text = normalize_path(path)
    .to_string_lossy()
    .replace('\\', "/");
  text.contains("/target/debug/")
}

fn port_open(port: u16) -> bool {
  let v4 = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
  let v6 = SocketAddr::from((Ipv6Addr::LOCALHOST, port));
  TcpStream::connect_timeout(&v4, Duration::from_millis(200)).is_ok()
    || TcpStream::connect_timeout(&v6, Duration::from_millis(200)).is_ok()
}

fn start_dev_server(source: &Path) -> Result<(), String> {
  let mut cmd = if cfg!(windows) {
    let mut c = Command::new("cmd");
    c.args(["/C", "npm", "start"]);
    c
  } else {
    let mut c = Command::new("npm");
    c.args(["start"]);
    c
  };
  cmd.current_dir(source);
  cmd.stdin(Stdio::null());
  cmd.stdout(Stdio::null());
  cmd.stderr(Stdio::null());
  #[cfg(windows)]
  {
    use std::os::windows::process::CommandExt;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
  }
  #[cfg(unix)]
  {
    use std::os::unix::process::CommandExt;
    cmd.process_group(0);
  }
  cmd.spawn().map(|_| ()).map_err(|e| format!("Could not start the app server: {e}"))
}

fn wait_for_port(port: u16, timeout: Duration) -> bool {
  let deadline = std::time::Instant::now() + timeout;
  while std::time::Instant::now() < deadline {
    if port_open(port) {
      return true;
    }
    thread::sleep(Duration::from_millis(400));
  }
  port_open(port)
}

fn reload_main_window(app: &AppHandle) {
  let handle = app.clone();
  let _ = app.run_on_main_thread(move || {
    let script = format!("location.replace({:?})", DEV_URL);
    for label in ["main", "debug"] {
      if let Some(window) = handle.get_webview_window(label) {
        let _ = window.eval(&script);
      }
    }
  });
}

/// After a debug self-improve, reload the existing webview. Do not start a
/// second `ng serve` from boot — that deadlocks `tauri dev` and freezes the UI.
fn reload_debug_frontend(app: &AppHandle) {
  if port_open(DEV_PORT) {
    reload_main_window(app);
    return;
  }
  let Ok(source) = working_source(app) else {
    reload_main_window(app);
    return;
  };
  let handle = app.clone();
  thread::spawn(move || {
    if !port_open(DEV_PORT) && source.join("package.json").is_file() {
      log::warn!("Ava's UI server is not running; starting it from {}", source.display());
      if let Err(error) = start_dev_server(&source) {
        log::warn!("{error}");
      }
      let _ = wait_for_port(DEV_PORT, Duration::from_secs(45));
    }
    reload_main_window(&handle);
  });
}

/// If a self-improved build exists, start it and tell the caller to exit.
/// Returns true when this process should quit.
pub fn hop_to_live_if_needed(app: &AppHandle) -> bool {
  if cfg!(debug_assertions) {
    remember_original(app);
    return false;
  }
  if reset_requested() {
    let _ = reset_inner(app, false);
    remember_original(app);
    return false;
  }
  if factory_requested() {
    remember_original(app);
    return false;
  }

  remember_original(app);
  let mut state = load_state(app);
  let Some(live) = live_exe_path(&state) else {
    return false;
  };
  let current = current_exe();
  if looks_like_debug_target(&live) && !looks_like_debug_target(&current) {
    log::warn!(
      "Skipping self-improved debug binary {}; it would load localhost.",
      live.display()
    );
    return false;
  }
  if same_path(&live, &current) {
    state.live_ok = true;
    let _ = save_state(app, &state);
    return false;
  }

  let now = now_secs();
  if !state.live_ok && state.last_hop_at > 0 && now.saturating_sub(state.last_hop_at) < CRASH_LOOP_SECS {
    log::warn!("Skipping self-improved Ava; it failed to stay open.");
    return false;
  }

  state.last_hop_at = now;
  state.live_ok = false;
  let _ = save_state(app, &state);
  match spawn_detached(&live, &[]) {
    Ok(()) => true,
    Err(error) => {
      log::warn!("Could not start self-improved Ava: {error}");
      false
    }
  }
}

fn tool(
  id: &str,
  label: &str,
  present: bool,
  install_url: &str,
  install_command: &str,
  detail: &str,
) -> ToolNeed {
  ToolNeed {
    id: id.into(),
    label: label.into(),
    present,
    install_url: install_url.into(),
    install_command: install_command.into(),
    detail: detail.into(),
  }
}

fn host_os() -> &'static str {
  if cfg!(target_os = "windows") {
    "windows"
  } else if cfg!(target_os = "macos") {
    "macos"
  } else {
    "linux"
  }
}

fn grok_install_command() -> &'static str {
  if cfg!(windows) {
    "irm https://x.ai/cli/install.ps1 | iex"
  } else {
    "curl -fsSL https://x.ai/cli/install.sh | bash"
  }
}

fn rust_install_command() -> &'static str {
  if cfg!(windows) {
    "irm https://win.rustup.rs | iex"
  } else {
    "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
  }
}

fn has_msvc() -> bool {
  #[cfg(windows)]
  {
    let vswhere = PathBuf::from(
      env::var("ProgramFiles(x86)").unwrap_or_else(|_| r"C:\Program Files (x86)".into()),
    )
    .join("Microsoft Visual Studio")
    .join("Installer")
    .join("vswhere.exe");
    if !vswhere.is_file() {
      return false;
    }
    let requires = [
      "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
      "Microsoft.VisualStudio.Component.VC.Tools.ARM64",
    ];
    for required in requires {
      let mut cmd = Command::new(&vswhere);
      cmd.args([
        "-latest",
        "-products",
        "*",
        "-requires",
        required,
        "-property",
        "installationPath",
      ]);
      hide_console(&mut cmd);
      let Ok(out) = cmd.output() else {
        continue;
      };
      if out.status.success() && !String::from_utf8_lossy(&out.stdout).trim().is_empty() {
        return true;
      }
    }
    false
  }
  #[cfg(not(windows))]
  {
    false
  }
}

fn has_xcode_clt() -> bool {
  #[cfg(target_os = "macos")]
  {
    Command::new("xcode-select")
      .arg("-p")
      .stdout(Stdio::null())
      .stderr(Stdio::null())
      .status()
      .map(|s| s.success())
      .unwrap_or(false)
  }
  #[cfg(not(target_os = "macos"))]
  {
    false
  }
}

fn cpp_tool() -> ToolNeed {
  if cfg!(windows) {
    tool(
      "cpp",
      "Visual Studio C++ tools",
      has_msvc(),
      "https://visualstudio.microsoft.com/visual-cpp-build-tools/",
      "",
      "Install Build Tools and select Desktop development with C++.",
    )
  } else if cfg!(target_os = "macos") {
    tool(
      "cpp",
      "Xcode command line tools",
      has_xcode_clt(),
      "https://developer.apple.com/xcode/",
      "xcode-select --install",
      "Needed to compile the desktop app.",
    )
  } else {
    tool(
      "cpp",
      "C compiler",
      has_cmd("cc") || has_cmd("gcc") || has_cmd("clang"),
      "",
      "sudo apt install build-essential",
      "A C compiler is needed to compile the desktop app.",
    )
  }
}

fn collect_tools() -> Vec<ToolNeed> {
  let mut tools = vec![
    tool(
      "node",
      "Node.js",
      has_cmd("node"),
      "https://nodejs.org/en/download",
      "",
      "Download the LTS installer. npm comes with it.",
    ),
    tool(
      "npm",
      "npm",
      has_cmd("npm"),
      "https://nodejs.org/en/download",
      "",
      "Comes with Node.js.",
    ),
    tool(
      "cargo",
      "Rust",
      has_cmd("cargo"),
      "https://rustup.rs/",
      rust_install_command(),
      "Install the stable toolchain with rustup.",
    ),
    cpp_tool(),
  ];
  if cfg!(all(windows, target_arch = "aarch64")) {
    tools.push(tool(
      "clang",
      "LLVM Clang",
      has_cmd("clang"),
      "https://releases.llvm.org/",
      "",
      "ARM64 Windows needs Clang to compile some Rust crates.",
    ));
  }
  tools
}

fn tool_status() -> (bool, bool, bool, Vec<ToolNeed>, Vec<String>) {
  let tools = collect_tools();
  let node = tools.iter().find(|t| t.id == "node").map(|t| t.present).unwrap_or(false);
  let npm = tools.iter().find(|t| t.id == "npm").map(|t| t.present).unwrap_or(false);
  let cargo = tools.iter().find(|t| t.id == "cargo").map(|t| t.present).unwrap_or(false);
  let missing: Vec<String> = tools
    .iter()
    .filter(|t| !t.present)
    .map(|t| t.label.clone())
    .collect();
  (node, npm, cargo, tools, missing)
}

fn status_message(ready: bool, missing: &[String], source_ok: bool) -> String {
  if !source_ok {
    return "This install does not include Ava's source.".into();
  }
  if missing.is_empty() && ready {
    return "Ava can change herself from this computer.".into();
  }
  if missing.is_empty() {
    return "Ava's source is here.".into();
  }
  format!("Need {} to compile a new Ava.", missing.join(", "))
}

#[tauri::command]
pub fn self_improve_status(app: AppHandle) -> Result<SelfImproveStatus, String> {
  let from_checkout = checkout_root().is_some();
  let source = working_source(&app).unwrap_or_default();
  let pristine = pristine_dir(&app).unwrap_or_default();
  let persist = load_state(&app);
  let source_ok = source.join("package.json").is_file() || bundled_source(&app).is_some() || from_checkout;
  let (node, npm, cargo, tools, missing) = tool_status();
  let ready = source_ok && missing.is_empty();
  Ok(SelfImproveStatus {
    desktop: true,
    from_checkout,
    customized: live_exe_path(&persist).is_some() || (!from_checkout && source.join("package.json").is_file() && persist.live_ok),
    armed: ARMED.load(Ordering::SeqCst),
    source_path: source.to_string_lossy().into_owned(),
    pristine_path: pristine.to_string_lossy().into_owned(),
    live_exe: persist.live_exe,
    original_exe: persist.original_exe,
    os: host_os().into(),
    node,
    npm,
    cargo,
    ready,
    message: status_message(ready, &missing, source_ok),
    missing,
    tools,
    grok_install_url: "https://x.ai/cli".into(),
    grok_install_command: grok_install_command().into(),
  })
}

#[tauri::command]
pub fn self_improve_ensure_source(app: AppHandle) -> Result<EnsureResult, String> {
  let path = if let Some(root) = checkout_root() {
    snapshot_if_needed(&app, &root)?;
    write_grok_mcp_config(&root)?;
    root
  } else {
    extract_bundled_if_needed(&app)?
  };
  Ok(EnsureResult {
    from_checkout: checkout_root().is_some(),
    path: path.to_string_lossy().into_owned(),
  })
}

#[tauri::command]
pub fn self_improve_arm() {
  ARMED.store(true, Ordering::SeqCst);
}

pub fn is_armed() -> bool {
  ARMED.load(Ordering::SeqCst)
}

fn run_in_source(source: &Path, program: &str, args: &[&str]) -> Result<(), String> {
  let mut cmd = if cfg!(windows) && program.eq_ignore_ascii_case("npm") {
    let mut c = Command::new("cmd");
    c.arg("/C").arg("npm");
    c.args(args);
    c
  } else {
    let mut c = Command::new(program);
    c.args(args);
    c
  };
  cmd.current_dir(source);
  cmd.stdin(Stdio::null());
  let output = cmd
    .output()
    .map_err(|e| format!("Could not run {program}: {e}"))?;
  if output.status.success() {
    return Ok(());
  }
  let stderr = String::from_utf8_lossy(&output.stderr);
  let stdout = String::from_utf8_lossy(&output.stdout);
  let detail = [stderr.trim(), stdout.trim()]
    .into_iter()
    .find(|row| !row.is_empty())
    .unwrap_or("compile failed");
  let clipped: String = detail.chars().rev().take(1800).collect::<String>().chars().rev().collect();
  Err(clipped)
}

pub fn verify_compile(source: &Path) -> Result<(), String> {
  if !source.join("package.json").is_file() {
    return Err("Ava's source is missing.".into());
  }
  if !source.join("node_modules").is_dir() {
    run_in_source(source, "npm", &["install"])?;
  }
  run_in_source(source, "npm", &["run", "build"])?;
  let clang = source.join("scripts").join("with-windows-clang.js");
  if clang.is_file() {
    let clang_s = clang.to_string_lossy().into_owned();
    run_in_source(
      source,
      "node",
      &[
        clang_s.as_str(),
        "cargo",
        "check",
        "--manifest-path",
        "src-tauri/Cargo.toml",
      ],
    )?;
  } else {
    run_in_source(
      source,
      "cargo",
      &["check", "--manifest-path", "src-tauri/Cargo.toml"],
    )?;
  }
  Ok(())
}

fn spawn_relaunch_helper(app: &AppHandle, source: &Path) -> Result<(), String> {
  let helper = source.join("scripts").join("self-improve-relaunch.js");
  if !helper.is_file() {
    return Err("Missing self-improve relaunch helper.".into());
  }
  let persist = load_state(app);
  let pid = std::process::id().to_string();
  let marker = state_path(app)?;
  let original = persist.original_exe;
  let mut cmd = Command::new("node");
  cmd
    .arg(&helper)
    .arg(&pid)
    .arg(source.as_os_str())
    .arg(marker.as_os_str())
    .arg(&original);
  cmd.stdin(Stdio::null());
  cmd.stdout(Stdio::null());
  cmd.stderr(Stdio::null());
  #[cfg(windows)]
  {
    use std::os::windows::process::CommandExt;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
  }
  #[cfg(unix)]
  {
    use std::os::unix::process::CommandExt;
    cmd.process_group(0);
  }
  cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

pub fn apply_and_relaunch(app: &AppHandle) -> Result<(), String> {
  let source = working_source(app)?;
  let _ = app.emit("self-improve://restarting", serde_json::json!({ "source": source }));
  ARMED.store(false, Ordering::SeqCst);

  if cfg!(debug_assertions) {
    // `request_restart()` relaunches target/debug/app.exe without `tauri dev`,
    // so the webview hits localhost with nobody listening. Keep this process
    // and reload the existing window instead.
    reload_debug_frontend(app);
    return Ok(());
  }

  spawn_relaunch_helper(app, &source)?;
  let handle = app.clone();
  thread::spawn(move || {
    thread::sleep(Duration::from_millis(400));
    handle.exit(0);
  });
  Ok(())
}

fn reset_inner(app: &AppHandle, relaunch: bool) -> Result<(), String> {
  ARMED.store(false, Ordering::SeqCst);
  let pristine = pristine_dir(app)?;
  if !pristine.join("package.json").is_file() {
    let mut state = load_state(app);
    state.live_exe.clear();
    state.live_ok = false;
    save_state(app, &state)?;
    if relaunch {
      relaunch_original(app)?;
    }
    return Ok(());
  }
  let source = working_source(app)?;
  if checkout_root().is_some() {
    restore_tree(&pristine, &source)?;
  } else {
    if source.exists() {
      match fs::remove_dir_all(&source) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
      }
    }
    copy_tree(&pristine, &source)?;
    write_grok_mcp_config(&source)?;
  }
  let mut state = load_state(app);
  state.live_exe.clear();
  state.live_ok = false;
  save_state(app, &state)?;
  if relaunch {
    relaunch_original(app)?;
  }
  Ok(())
}

fn relaunch_original(app: &AppHandle) -> Result<(), String> {
  let persist = load_state(app);
  let original = persist.original_exe.trim();
  let current = current_exe();
  if !original.is_empty() {
    let path = PathBuf::from(original);
    if path.is_file() && !same_path(&path, &current) {
      spawn_detached(&path, &["--factory"])?;
      let handle = app.clone();
      thread::spawn(move || {
        thread::sleep(Duration::from_millis(400));
        handle.exit(0);
      });
      return Ok(());
    }
  }
  if cfg!(debug_assertions) {
    reload_debug_frontend(app);
    return Ok(());
  }
  Ok(())
}

#[tauri::command]
pub fn self_improve_reset(app: AppHandle) -> Result<(), String> {
  reset_inner(&app, true)
}

#[tauri::command]
pub fn self_improve_apply(app: AppHandle) -> Result<(), String> {
  if !is_armed() {
    return Err("No self-improvement is in progress.".into());
  }
  let source = working_source(&app)?;
  verify_compile(&source)?;
  apply_and_relaunch(&app)
}

/// MCP entry: compile must already be green, then Ava goes to sleep and restarts.
pub fn ready_from_mcp(app: &AppHandle) -> Result<String, String> {
  if !is_armed() {
    return Err("No self-improvement is in progress.".into());
  }
  let source = working_source(app)?;
  verify_compile(&source)?;
  apply_and_relaunch(app)?;
  Ok("Compile succeeded. Ava will restart now.".into())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn skip_list_covers_build_artifacts() {
    assert!(skip_name("node_modules"));
    assert!(skip_name("target"));
    assert!(skip_name("ava-src"));
    assert!(!skip_name("src"));
  }

  #[test]
  fn copy_tree_skips_nested_artifacts() {
    let tmp = env::temp_dir().join(format!("ava-self-improve-{}", std::process::id()));
    let src = tmp.join("src");
    let dst = tmp.join("dst");
    let _ = fs::remove_dir_all(&tmp);
    fs::create_dir_all(src.join("src")).unwrap();
    fs::create_dir_all(src.join("node_modules")).unwrap();
    fs::write(src.join("package.json"), "{}").unwrap();
    fs::write(src.join("src").join("app.ts"), "ok").unwrap();
    fs::write(src.join("node_modules").join("x"), "skip").unwrap();
    copy_tree(&src, &dst).unwrap();
    assert!(dst.join("package.json").is_file());
    assert!(dst.join("src").join("app.ts").is_file());
    assert!(!dst.join("node_modules").exists());
    let _ = fs::remove_dir_all(&tmp);
  }

  #[test]
  fn same_path_is_case_insensitive_on_windows() {
    let a = PathBuf::from(r"C:\Ava\App.exe");
    let b = PathBuf::from(r"c:/ava/app.exe");
    if cfg!(windows) {
      assert!(same_path(&a, &b));
    }
  }

  #[test]
  fn debug_target_path_is_detected() {
    assert!(looks_like_debug_target(Path::new(
      r"C:\src\ava\src-tauri\target\debug\app.exe"
    )));
    assert!(!looks_like_debug_target(Path::new(
      r"C:\src\ava\src-tauri\target\release\app.exe"
    )));
  }

  #[test]
  fn collect_tools_covers_compile_needs() {
    let tools = collect_tools();
    let ids: Vec<&str> = tools.iter().map(|t| t.id.as_str()).collect();
    assert!(ids.contains(&"node"));
    assert!(ids.contains(&"npm"));
    assert!(ids.contains(&"cargo"));
    assert!(ids.contains(&"cpp"));
    for tool in &tools {
      if !tool.present {
        assert!(
          !tool.install_url.is_empty() || !tool.install_command.is_empty(),
          "{} should explain how to install",
          tool.id
        );
      }
    }
  }

  #[test]
  fn grok_install_points_at_official_cli() {
    let command = grok_install_command();
    assert!(command.contains("x.ai/cli"));
  }
}
