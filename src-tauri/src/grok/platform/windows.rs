use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::Command;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub fn prepare_session() {
    use windows_sys::Win32::System::Console::{AllocConsole, GetConsoleWindow};
    use windows_sys::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_HIDE};
    unsafe {
        AllocConsole();
        let hwnd = GetConsoleWindow();
        if !hwnd.is_null() {
            ShowWindow(hwnd, SW_HIDE);
        }
    }
}

pub fn prepare_agent_session() {
    prepare_session();
}

pub fn decorate_cli(cmd: &mut Command) {
    cmd.creation_flags(CREATE_NO_WINDOW);
}

pub fn decorate_agent(cmd: &mut Command) {
    decorate_cli(cmd);
}

pub fn kill_process_tree(pid: u32) {
    let _ = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
}

pub fn pid_alive(pid: u32) -> bool {
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    const STILL_ACTIVE: u32 = 259;
    extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut std::ffi::c_void;
        fn GetExitCodeProcess(handle: *mut std::ffi::c_void, code: *mut u32) -> i32;
        fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
    }
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return false;
        }
        let mut code = 0u32;
        let ok = GetExitCodeProcess(handle, &mut code) != 0;
        CloseHandle(handle);
        ok && code == STILL_ACTIVE
    }
}

pub fn open_path(path: &str) -> Result<(), String> {
    Command::new("cmd")
        .args(["/C", "start", "", path])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn reveal_args(path: &str) -> (&'static str, Vec<String>) {
    let native = path.replace('/', "\\");
    ("explorer", vec![format!("/select,{native}")])
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
    if base.to_ascii_lowercase().ends_with(".exe") {
        base.to_string()
    } else {
        format!("{base}.exe")
    }
}

pub fn executable_suffixes() -> Vec<String> {
    std::env::var("PATHEXT")
        .unwrap_or_else(|_| ".EXE;.CMD;.BAT".into())
        .split(';')
        .map(|s| s.to_string())
        .collect()
}

pub fn extra_bin_dirs() -> Vec<PathBuf> {
    Vec::new()
}

pub fn login_path() -> Option<String> {
    None
}
