//! OS operations the rest of the host must not `cfg` for.
//!
//! Windows and Unix implement the same function set. Callers
//! (`grok_bin`, `media`, `session_index`)
//! go through this module only.

use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use serde::Serialize;

#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;

#[cfg(unix)]
use unix as sys;
#[cfg(windows)]
use windows as sys;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostInfo {
    pub os: &'static str,
    pub family: &'static str,
    pub window_chrome: &'static str,
    pub updater_disabled: bool,
}

fn updater_disabled() -> bool {
    match env::var("AVA_DISABLE_UPDATER") {
        Ok(value) => {
            let value = value.trim();
            value == "1" || value.eq_ignore_ascii_case("true")
        }
        Err(_) => false,
    }
}

pub fn host_info() -> HostInfo {
    #[cfg(target_os = "windows")]
    {
        HostInfo {
            os: "windows",
            family: "windows",
            window_chrome: "custom",
            updater_disabled: updater_disabled(),
        }
    }
    #[cfg(target_os = "macos")]
    {
        HostInfo {
            os: "macos",
            family: "unix",
            window_chrome: "overlay",
            updater_disabled: updater_disabled(),
        }
    }
    #[cfg(target_os = "linux")]
    {
        HostInfo {
            os: "linux",
            family: "unix",
            window_chrome: "custom",
            updater_disabled: updater_disabled(),
        }
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        HostInfo {
            os: "unknown",
            family: "unknown",
            window_chrome: "custom",
            updater_disabled: updater_disabled(),
        }
    }
}

/// Process-wide setup: hidden console on Windows, GUI PATH on macOS.
pub fn init() {
    sys::prepare_session();
    augment_search_path();
}

pub fn decorate_cli(cmd: &mut Command) {
    sys::decorate_cli(cmd);
}

pub fn prepare_agent_session() {
    sys::prepare_agent_session();
}

pub fn decorate_agent(cmd: &mut Command) {
    sys::decorate_agent(cmd);
}

pub fn kill_process_tree(pid: u32) {
    sys::kill_process_tree(pid);
}

pub fn open_path(path: &str) -> Result<(), String> {
    sys::open_path(path)
}

pub fn reveal_path(path: &str) -> Result<(), String> {
    sys::reveal_path(path)
}

pub fn exe_name(base: &str) -> String {
    sys::exe_name(base)
}

pub fn grok_not_found_message(bin_dir: &Path) -> String {
    format!("grok not found on PATH or {}", bin_dir.display())
}

pub fn which(name: &str) -> Result<PathBuf, ()> {
    let suffixes = sys::executable_suffixes();
    let path = env::var_os("PATH").ok_or(())?;
    for dir in env::split_paths(&path) {
        for ext in &suffixes {
            let already_suffixed = ext.is_empty()
                || name
                    .to_ascii_lowercase()
                    .ends_with(&ext.to_ascii_lowercase());
            let candidate = if already_suffixed {
                dir.join(name)
            } else {
                dir.join(format!("{name}{ext}"))
            };
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }
    Err(())
}

fn extra_bin_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(home) = dirs::home_dir() {
        dirs.push(home.join(".grok").join("bin"));
        dirs.push(home.join(".local").join("bin"));
        dirs.push(home.join("bin"));
    }
    dirs.extend(sys::extra_bin_dirs());
    dirs.into_iter().filter(|p| p.is_dir()).collect()
}

fn augment_search_path() {
    let mut parts: Vec<PathBuf> = extra_bin_dirs();
    if let Some(login) = sys::login_path() {
        for dir in env::split_paths(&login) {
            if dir.is_dir() && !parts.iter().any(|p| p == &dir) {
                parts.push(dir);
            }
        }
    }
    let current = env::var_os("PATH").unwrap_or_default();
    for dir in env::split_paths(&current) {
        if !parts.iter().any(|p| p == &dir) {
            parts.push(dir);
        }
    }
    if let Ok(joined) = env::join_paths(parts) {
        env::set_var("PATH", joined);
    }
}

/// Best-effort login-shell PATH. Used by macOS GUI apps whose inherited PATH
/// is `/usr/bin:/bin:/usr/sbin:/sbin`.
pub(crate) fn read_login_path(shell: &str, timeout: Duration) -> Option<String> {
    let mut child = Command::new(shell)
        .args(["-l", "-c", "printf %s \"$PATH\""])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => {
                let mut buf = String::new();
                if let Some(mut out) = child.stdout.take() {
                    use std::io::Read;
                    let _ = out.read_to_string(&mut buf);
                }
                let trimmed = buf
                    .lines()
                    .map(str::trim)
                    .rfind(|line| !line.is_empty())
                    .unwrap_or("");
                if trimmed.is_empty() {
                    return None;
                }
                return Some(trimmed.to_string());
            }
            Ok(Some(_)) => return None,
            Ok(None) if start.elapsed() < timeout => {
                std::thread::sleep(Duration::from_millis(20));
            }
            Ok(None) => {
                let _ = child.kill();
                return None;
            }
            Err(_) => return None,
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn host_matches_compile_target() {
        let host = super::host_info();
        #[cfg(target_os = "macos")]
        {
            assert_eq!(host.os, "macos");
            assert_eq!(host.family, "unix");
            assert_eq!(host.window_chrome, "overlay");
        }
        #[cfg(target_os = "windows")]
        {
            assert_eq!(host.os, "windows");
            assert_eq!(host.family, "windows");
            assert_eq!(host.window_chrome, "custom");
        }
        #[cfg(target_os = "linux")]
        {
            assert_eq!(host.os, "linux");
            assert_eq!(host.family, "unix");
        }
    }

    #[test]
    fn which_finds_a_system_binary() {
        #[cfg(unix)]
        {
            let sh = super::which("sh").expect("sh on unix PATH");
            assert!(sh.is_file());
        }
        #[cfg(windows)]
        {
            let cmd = super::which("cmd").expect("cmd on windows PATH");
            assert!(cmd.is_file());
        }
    }

    #[test]
    fn reveal_args_select_the_file() {
        #[cfg(unix)]
        {
            let (bin, args) = super::sys::reveal_args("/tmp/pack.zip");
            #[cfg(target_os = "macos")]
            {
                assert_eq!(bin, "open");
                assert_eq!(args, ["-R", "/tmp/pack.zip"]);
            }
            #[cfg(not(target_os = "macos"))]
            {
                assert_eq!(bin, "xdg-open");
                assert_eq!(args, ["/tmp"]);
            }
        }
        #[cfg(windows)]
        {
            let (bin, args) = super::sys::reveal_args(r"C:\tmp\pack.zip");
            assert_eq!(bin, "explorer");
            assert_eq!(args, [r"/select,C:\tmp\pack.zip"]);
        }
    }
}
