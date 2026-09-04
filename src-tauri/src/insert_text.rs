use std::sync::mpsc;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Manager, State};

#[derive(Default, Clone, Copy)]
struct FocusTarget {
  root: isize,
  focus: isize,
}

#[derive(Default)]
pub struct FocusWatch {
  target: Mutex<FocusTarget>,
}

impl FocusWatch {
  fn remember(&self, root: isize, focus: isize) {
    if root == 0 {
      return;
    }
    if let Ok(mut slot) = self.target.lock() {
      *slot = FocusTarget { root, focus };
    }
  }

  fn current(&self) -> FocusTarget {
    self.target.lock().map(|slot| *slot).unwrap_or_default()
  }
}

pub fn start(app: AppHandle) {
  #[cfg(windows)]
  thread::spawn(move || loop {
    thread::sleep(Duration::from_millis(220));
    remember_foreign_focus(&app);
  });
  #[cfg(not(windows))]
  let _ = app;
}

#[tauri::command]
pub fn remember_insert_target(app: AppHandle) {
  #[cfg(windows)]
  remember_foreign_focus(&app);
  #[cfg(not(windows))]
  let _ = app;
}

#[tauri::command]
pub fn insert_into_focused_field(
  app: AppHandle,
  watch: State<FocusWatch>,
  text: String,
) -> Result<(), String> {
  let body = text.trim();
  if body.is_empty() {
    return Err("Nothing to insert.".into());
  }

  #[cfg(windows)]
  {
    let target = watch.current();
    insert_on_main_thread(&app, target, body)
  }
  #[cfg(not(windows))]
  {
    let _ = (app, watch);
    Err("Typing into other apps is only available on Windows for now.".into())
  }
}

#[cfg(windows)]
fn insert_on_main_thread(app: &AppHandle, target: FocusTarget, text: &str) -> Result<(), String> {
  let (tx, rx) = mpsc::channel();
  let owned = text.to_string();
  app
    .run_on_main_thread(move || {
      let result = insert_windows(target, &owned);
      let _ = tx.send(result);
    })
    .map_err(|error| error.to_string())?;
  rx.recv_timeout(Duration::from_secs(3))
    .map_err(|_| "Timed out waiting to insert text.".to_string())?
}

#[cfg(windows)]
fn remember_foreign_focus(app: &AppHandle) {
  use windows_sys::Win32::System::Threading::GetCurrentProcessId;
  use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetAncestor, GetForegroundWindow, GetGUIThreadInfo, GetWindowThreadProcessId, IsWindow,
    IsWindowVisible, GA_ROOT, GUITHREADINFO,
  };

  unsafe {
    let fg = GetForegroundWindow();
    if fg.is_null() || IsWindow(fg) == 0 || IsWindowVisible(fg) == 0 {
      return;
    }
    if window_pid(fg) == GetCurrentProcessId() {
      return;
    }
    let root = {
      let ancestor = GetAncestor(fg, GA_ROOT);
      if ancestor.is_null() { fg } else { ancestor }
    };
    if window_pid(root) == GetCurrentProcessId() {
      return;
    }
    if is_shell_window(root) {
      return;
    }

    let thread = GetWindowThreadProcessId(fg, std::ptr::null_mut());
    let mut info: GUITHREADINFO = std::mem::zeroed();
    info.cbSize = std::mem::size_of::<GUITHREADINFO>() as u32;
    let focus = if thread != 0 && GetGUIThreadInfo(thread, &mut info) != 0 && !info.hwndFocus.is_null()
    {
      info.hwndFocus as isize
    } else {
      0
    };

    if let Some(watch) = app.try_state::<FocusWatch>() {
      watch.remember(root as isize, focus);
    }
  }
}

#[cfg(windows)]
fn window_pid(hwnd: windows_sys::Win32::Foundation::HWND) -> u32 {
  use windows_sys::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;
  let mut pid = 0u32;
  unsafe {
    GetWindowThreadProcessId(hwnd, &mut pid);
  }
  pid
}

#[cfg(windows)]
fn is_shell_window(hwnd: windows_sys::Win32::Foundation::HWND) -> bool {
  use windows_sys::Win32::UI::WindowsAndMessaging::GetClassNameW;
  let mut buf = [0u16; 64];
  let len = unsafe { GetClassNameW(hwnd, buf.as_mut_ptr(), buf.len() as i32) };
  if len <= 0 {
    return false;
  }
  let name = String::from_utf16_lossy(&buf[..len as usize]);
  matches!(
    name.as_str(),
    "Shell_TrayWnd"
      | "Shell_SecondaryTrayWnd"
      | "Progman"
      | "WorkerW"
      | "NotifyIconOverflowWindow"
      | "Windows.UI.Core.CoreWindow"
  )
}

#[cfg(windows)]
fn insert_windows(stored: FocusTarget, text: &str) -> Result<(), String> {
  use windows_sys::Win32::Foundation::HWND;
  use windows_sys::Win32::System::Threading::{
    AttachThreadInput, GetCurrentProcessId, GetCurrentThreadId,
  };
  use windows_sys::Win32::UI::Input::KeyboardAndMouse::{SetActiveWindow, SetFocus};
  use windows_sys::Win32::UI::WindowsAndMessaging::{
    AllowSetForegroundWindow, BringWindowToTop, GetForegroundWindow, GetWindowThreadProcessId,
    IsIconic, IsWindow, SetForegroundWindow, ShowWindow, SW_RESTORE,
  };

  let our_pid = unsafe { GetCurrentProcessId() };
  let mut root = stored.root as HWND;
  if root.is_null() || unsafe { IsWindow(root) } == 0 || window_pid(root) == our_pid {
    let fg = unsafe { GetForegroundWindow() };
    if fg.is_null() || window_pid(fg) == our_pid {
      return Err("Click the field you want, then ask me again.".into());
    }
    root = fg;
  }

  let mut focus = stored.focus as HWND;
  if focus.is_null() || unsafe { IsWindow(focus) } == 0 || window_pid(focus) == our_pid {
    focus = std::ptr::null_mut();
  }

  unsafe {
    let _ = AllowSetForegroundWindow(u32::MAX);
    if IsIconic(root) != 0 {
      ShowWindow(root, SW_RESTORE);
    }

    let target_thread = GetWindowThreadProcessId(root, std::ptr::null_mut());
    let current_thread = GetCurrentThreadId();
    let attached = target_thread != 0
      && target_thread != current_thread
      && AttachThreadInput(current_thread, target_thread, 1) != 0;

    let _ = BringWindowToTop(root);
    let _ = SetForegroundWindow(root);
    let _ = SetActiveWindow(root);
    if !focus.is_null() {
      let _ = SetFocus(focus);
    }

    let mut focused = false;
    for _ in 0..8 {
      thread::sleep(Duration::from_millis(30));
      let fg = GetForegroundWindow();
      if !fg.is_null() && window_pid(fg) != our_pid {
        focused = true;
        break;
      }
      let _ = SetForegroundWindow(root);
      if !focus.is_null() {
        let _ = SetFocus(focus);
      }
    }

    let result = if !focused {
      Err("Click the field you want, then ask me again.".into())
    } else {
      paste_text(text)
    };

    if attached {
      AttachThreadInput(current_thread, target_thread, 0);
    }
    result
  }
}

#[cfg(windows)]
fn paste_text(text: &str) -> Result<(), String> {
  let previous = read_clipboard();
  set_clipboard(text)?;
  thread::sleep(Duration::from_millis(40));
  send_paste()?;
  thread::sleep(Duration::from_millis(280));
  if let Some(old) = previous {
    let _ = set_clipboard(&old);
  }
  Ok(())
}

#[cfg(windows)]
fn set_clipboard(text: &str) -> Result<(), String> {
  use windows_sys::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, SetClipboardData,
  };
  use windows_sys::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};

  const CF_UNICODETEXT: u32 = 13;
  const GMEM_ZEROINIT: u32 = 0x40;

  let mut wide: Vec<u16> = text.encode_utf16().collect();
  wide.push(0);
  let bytes = wide.len() * std::mem::size_of::<u16>();

  unsafe {
    open_clipboard()?;
    if EmptyClipboard() == 0 {
      CloseClipboard();
      return Err("Could not clear the clipboard.".into());
    }
    let handle = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, bytes);
    if handle.is_null() {
      CloseClipboard();
      return Err("Could not allocate clipboard memory.".into());
    }
    let ptr = GlobalLock(handle);
    if ptr.is_null() {
      CloseClipboard();
      return Err("Could not write clipboard memory.".into());
    }
    std::ptr::copy_nonoverlapping(wide.as_ptr(), ptr as *mut u16, wide.len());
    GlobalUnlock(handle);
    if SetClipboardData(CF_UNICODETEXT, handle).is_null() {
      CloseClipboard();
      return Err("Could not set clipboard text.".into());
    }
    CloseClipboard();
  }
  Ok(())
}

#[cfg(windows)]
fn read_clipboard() -> Option<String> {
  use windows_sys::Win32::System::DataExchange::{CloseClipboard, GetClipboardData, OpenClipboard};
  use windows_sys::Win32::System::Memory::{GlobalLock, GlobalUnlock};

  const CF_UNICODETEXT: u32 = 13;
  unsafe {
    if OpenClipboard(std::ptr::null_mut()) == 0 {
      return None;
    }
    let handle = GetClipboardData(CF_UNICODETEXT);
    if handle.is_null() {
      CloseClipboard();
      return None;
    }
    let ptr = GlobalLock(handle) as *const u16;
    if ptr.is_null() {
      CloseClipboard();
      return None;
    }
    let mut len = 0usize;
    while *ptr.add(len) != 0 {
      len += 1;
    }
    let slice = std::slice::from_raw_parts(ptr, len);
    let text = String::from_utf16_lossy(slice);
    GlobalUnlock(handle);
    CloseClipboard();
    Some(text)
  }
}

#[cfg(windows)]
fn open_clipboard() -> Result<(), String> {
  use windows_sys::Win32::System::DataExchange::OpenClipboard;
  for _ in 0..12 {
    if unsafe { OpenClipboard(std::ptr::null_mut()) } != 0 {
      return Ok(());
    }
    thread::sleep(Duration::from_millis(20));
  }
  Err("Could not open the clipboard.".into())
}

#[cfg(windows)]
fn send_paste() -> Result<(), String> {
  use windows_sys::Win32::UI::Input::KeyboardAndMouse::{SendInput, INPUT, VK_CONTROL, VK_V};

  let keys = [
    key_input(VK_CONTROL, false),
    key_input(VK_V, false),
    key_input(VK_V, true),
    key_input(VK_CONTROL, true),
  ];
  let sent = unsafe {
    SendInput(
      keys.len() as u32,
      keys.as_ptr(),
      std::mem::size_of::<INPUT>() as i32,
    )
  };
  if sent != keys.len() as u32 {
    return Err("Could not paste into the other app.".into());
  }
  Ok(())
}

#[cfg(windows)]
fn key_input(vk: u16, up: bool) -> windows_sys::Win32::UI::Input::KeyboardAndMouse::INPUT {
  use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP,
  };
  INPUT {
    r#type: INPUT_KEYBOARD,
    Anonymous: INPUT_0 {
      ki: KEYBDINPUT {
        wVk: vk,
        wScan: 0,
        dwFlags: if up { KEYEVENTF_KEYUP } else { 0 },
        time: 0,
        dwExtraInfo: 0,
      },
    },
  }
}
