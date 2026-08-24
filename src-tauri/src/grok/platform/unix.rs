use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

pub fn prepare_session() {}

pub fn prepare_agent_session() {}

pub fn decorate_cli(_cmd: &mut Command) {}

pub fn decorate_agent(cmd: &mut Command) {
    use std::os::unix::process::CommandExt;
    unsafe {
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
}

pub fn kill_process_tree(pid: u32) {
    unsafe {
        let p = pid as i32;
        if libc::kill(-p, libc::SIGTERM) != 0 {
            libc::kill(p, libc::SIGTERM);
        }
    }
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(800));
        if pid_alive(pid) {
            unsafe {
                let p = pid as i32;
                if libc::kill(-p, libc::SIGKILL) != 0 {
                    libc::kill(p, libc::SIGKILL);
                }
            }
        }
    });
}

pub fn pid_alive(pid: u32) -> bool {
    let rc = unsafe { libc::kill(pid as i32, 0) };
    if rc == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

pub fn open_path(path: &str) -> Result<(), String> {
    let bin = if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    Command::new(bin)
        .arg(path)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn reveal_args(path: &str) -> (&'static str, Vec<String>) {
    if cfg!(target_os = "macos") {
        return ("open", vec!["-R".into(), path.to_string()]);
    }
    let target = Path::new(path);
    let folder = if target.is_dir() {
        path.to_string()
    } else {
        target
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .map(|parent| parent.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.to_string())
    };
    ("xdg-open", vec![folder])
}

pub fn reveal_path(path: &str) -> Result<(), String> {
    let (bin, args) = reveal_args(path);
    Command::new(bin)
        .args(args)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn exe_name(base: &str) -> String {
    base.to_string()
}

pub fn executable_suffixes() -> Vec<String> {
    vec![String::new()]
}

pub fn extra_bin_dirs() -> Vec<PathBuf> {
    let mut dirs = vec![PathBuf::from("/usr/local/bin")];
    if cfg!(target_os = "macos") {
        dirs.push(PathBuf::from("/opt/homebrew/bin"));
        dirs.push(PathBuf::from("/opt/homebrew/sbin"));
    }
    dirs
}

pub fn login_path() -> Option<String> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    super::read_login_path(&shell, Duration::from_millis(600))
}
