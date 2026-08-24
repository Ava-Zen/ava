use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use crate::grok::platform;
use crate::grok::types::{GrokInfo, GrokUpdateCheck};

/// Short-lived CLI operations such as version checks and updates. No child shells.
pub fn command(bin: &Path) -> Command {
    let mut cmd = Command::new(bin);
    platform::decorate_cli(&mut cmd);
    cmd
}

/// Long-lived `grok agent`. On Windows this inherits the hidden console so
/// grok's own `cmd.exe` tools do not AllocConsole a visible window.
/// `GROK_CLIENT_VERSION` lands in grok's own unified log, so a session's
/// traces name the client that drove it.
pub fn command_agent(bin: &Path) -> Command {
    platform::prepare_agent_session();
    let mut cmd = Command::new(bin);
    cmd.env(
        "GROK_CLIENT_VERSION",
        concat!("ava/", env!("CARGO_PKG_VERSION")),
    );
    platform::decorate_agent(&mut cmd);
    cmd
}

pub fn grok_home() -> PathBuf {
    if let Ok(home) = std::env::var("GROK_HOME") {
        return PathBuf::from(home);
    }
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".grok")
}

pub const INSTALL_SH: &str = "https://x.ai/cli/install.sh";
pub const INSTALL_PS1: &str = "https://x.ai/cli/install.ps1";

pub fn install_script_url() -> &'static str {
    if cfg!(windows) {
        INSTALL_PS1
    } else {
        INSTALL_SH
    }
}

fn installer_command() -> Command {
    if cfg!(windows) {
        let mut cmd = Command::new("powershell");
        cmd.args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            "irm https://x.ai/cli/install.ps1 | iex",
        ]);
        cmd
    } else {
        let mut cmd = Command::new("bash");
        cmd.args([
            "-lc",
            "curl --proto '=https' --tlsv1.2 -fsSL https://x.ai/cli/install.sh | bash",
        ]);
        cmd
    }
}

/// Set once a `slow` run finishes, which drops the pretence so the app boots on
/// into the real binary.
static FAKE_SATISFIED: AtomicBool = AtomicBool::new(false);

/// Called on every fresh boot, so reloading the window replays the whole setup
/// flow instead of granting one look per app launch.
pub fn rearm_fake() {
    FAKE_SATISFIED.store(false, Ordering::Relaxed);
}

/// `AVA_FAKE_NO_GROK` drives the missing-binary boot on a machine that already
/// has grok. `slow` ends in success, `fail` keeps failing so retries stay
/// reachable. Debug builds only, so release can never pretend.
fn fake_mode() -> Option<String> {
    if !cfg!(debug_assertions) || FAKE_SATISFIED.load(Ordering::Relaxed) {
        return None;
    }
    let mode = std::env::var("AVA_FAKE_NO_GROK")
        .ok()?
        .trim()
        .to_ascii_lowercase();
    match mode.as_str() {
        "" | "0" | "false" => None,
        _ => Some(mode),
    }
}

/// Paced stand-in for the real installer: never touches the network, never
/// writes to disk.
fn install_fake(mode: &str, mut emit: impl FnMut(String)) -> Result<(), String> {
    for step in [
        "Fetching installer from x.ai…",
        "Downloading grok (134 MB)…",
        "Verifying download…",
        "Linking into ~/.grok/bin…",
    ] {
        emit(step.to_string());
        std::thread::sleep(Duration::from_millis(1600));
    }
    if mode == "fail" {
        return Err("The Grok Build installer exited with an error.".into());
    }
    FAKE_SATISFIED.store(true, Ordering::Relaxed);
    Ok(())
}

/// Run the official xAI installer and emit captured output.
pub fn install_cli(mut emit: impl FnMut(String)) -> Result<(), String> {
    if let Some(mode) = fake_mode() {
        return install_fake(&mode, emit);
    }
    emit(format!(
        "Installing Grok Build from {}…",
        install_script_url()
    ));
    let mut cmd = installer_command();
    platform::decorate_cli(&mut cmd);
    let out = cmd
        .output()
        .map_err(|e| format!("could not start the Grok Build installer: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    for line in stdout.lines().chain(stderr.lines()) {
        let text = line.trim();
        if !text.is_empty() {
            emit(text.to_string());
        }
    }
    if !out.status.success() {
        return Err("The Grok Build installer exited with an error.".into());
    }
    Ok(())
}

pub fn resolve_grok_bin() -> Result<PathBuf, String> {
    if fake_mode().is_some() {
        return Err(platform::grok_not_found_message(&grok_home().join("bin")));
    }
    if let Ok(p) = std::env::var("AVA_GROK_BIN") {
        let path = PathBuf::from(p);
        if path.is_file() {
            return Ok(path);
        }
    }
    if let Ok(path) = platform::which("grok") {
        return Ok(path);
    }
    let bin_dir = grok_home().join("bin");
    let fallback = bin_dir.join(platform::exe_name("grok"));
    if fallback.is_file() {
        return Ok(fallback);
    }
    Err(platform::grok_not_found_message(&bin_dir))
}

pub fn grok_version(bin: &Path) -> Result<String, String> {
    let out = command(bin)
        .arg("--version")
        .output()
        .map_err(|e| format!("failed to run grok --version: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "grok --version failed: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

pub fn inspect(bin: &Path) -> GrokInfo {
    let path = bin.display().to_string();
    let version = grok_version(bin).unwrap_or_else(|_| "unknown".into());
    GrokInfo {
        path,
        version,
        grok_home: grok_home().display().to_string(),
    }
}

/// `grok update --check --json` — does not replace the binary.
pub fn check_update(bin: &Path) -> Result<GrokUpdateCheck, String> {
    let stdout = run_grok(bin, &["update", "--check", "--json"])?;
    parse_update_check(&stdout)
}

/// `grok update` — replaces the CLI on disk. The running agent process is
/// still the old binary until the host stops and starts it.
pub fn update_cli(bin: &Path, mut emit: impl FnMut(String)) -> Result<(), String> {
    emit("Updating Grok Build…".into());
    let mut cmd = command(bin);
    cmd.arg("update");
    platform::decorate_cli(&mut cmd);
    let out = cmd
        .output()
        .map_err(|e| format!("could not start grok update: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    for line in stdout.lines().chain(stderr.lines()) {
        let text = line.trim();
        if !text.is_empty() {
            emit(text.to_string());
        }
    }
    if !out.status.success() {
        return Err(if stderr.trim().is_empty() {
            "Grok Build failed to update.".into()
        } else {
            stderr.trim().to_string()
        });
    }
    Ok(())
}

pub fn parse_update_check(stdout: &str) -> Result<GrokUpdateCheck, String> {
    let blob = json_object(stdout).ok_or_else(|| {
        "grok update --check did not return JSON. This Grok Build may be too old to self-update."
            .to_string()
    })?;
    let raw: serde_json::Value = serde_json::from_str(blob)
        .map_err(|e| format!("could not parse grok update --check: {e}"))?;
    if let Some(err) = raw.get("error").and_then(|v| v.as_str()) {
        if !err.is_empty() {
            return Err(err.to_string());
        }
    }
    let current = raw
        .get("currentVersion")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let latest = raw
        .get("latestVersion")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let available = raw
        .get("updateAvailable")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let channel = raw
        .get("channel")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    Ok(GrokUpdateCheck {
        current_version: current,
        latest_version: latest,
        update_available: available,
        channel,
        error: None,
    })
}

fn json_object(s: &str) -> Option<&str> {
    let start = s.find('{')?;
    let end = s.rfind('}')?;
    if end < start {
        return None;
    }
    Some(&s[start..=end])
}

pub fn run_grok(bin: &Path, args: &[&str]) -> Result<String, String> {
    let out = command(bin)
        .args(args)
        .output()
        .map_err(|e| format!("failed to run grok {:?}: {e}", args))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let stdout = String::from_utf8_lossy(&out.stdout);
        return Err(if err.trim().is_empty() {
            stdout.trim().to_string()
        } else {
            err.trim().to_string()
        });
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn official_installer_is_xai() {
        assert!(install_script_url().starts_with("https://x.ai/cli/install."));
    }

    #[test]
    fn parse_update_check_reads_grok_json() {
        let raw = r#"{"currentVersion":"1.0.5","latestVersion":"1.0.8","updateAvailable":true,"installer":"internal","channel":"stable","autoUpdate":true,"error":null}"#;
        let check = parse_update_check(raw).expect("json");
        assert_eq!(check.current_version, "1.0.5");
        assert_eq!(check.latest_version, "1.0.8");
        assert!(check.update_available);
        assert_eq!(check.channel, "stable");
    }

    #[test]
    fn parse_update_check_skips_log_prefix() {
        let raw = "checking…\n{\"currentVersion\":\"1.0.5\",\"latestVersion\":\"1.0.5\",\"updateAvailable\":false,\"error\":null}\n";
        let check = parse_update_check(raw).expect("json");
        assert!(!check.update_available);
        assert_eq!(check.latest_version, "1.0.5");
    }

    #[test]
    fn parse_update_check_surfaces_error_field() {
        let raw = r#"{"currentVersion":"1.0.5","latestVersion":"1.0.5","updateAvailable":false,"error":"rate limited"}"#;
        let err = parse_update_check(raw).expect_err("error field");
        assert!(err.contains("rate limited"));
    }
}
