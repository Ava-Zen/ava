use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Mutex, OnceLock};
use std::thread;

use tauri::{AppHandle, Emitter};

const DEFAULT_VK: u32 = 0x77; // F8

struct HotkeyHub {
  vk: AtomicU32,
  down: AtomicBool,
  app: Mutex<Option<AppHandle>>,
}

static HUB: OnceLock<HotkeyHub> = OnceLock::new();

fn hub() -> &'static HotkeyHub {
  HUB.get_or_init(|| HotkeyHub {
    vk: AtomicU32::new(DEFAULT_VK),
    down: AtomicBool::new(false),
    app: Mutex::new(None),
  })
}

pub fn start(app: AppHandle) {
  if let Ok(mut slot) = hub().app.lock() {
    *slot = Some(app);
  }
  #[cfg(windows)]
  thread::spawn(install_hook);
}

#[tauri::command]
pub fn set_listen_hotkey(key: String) -> Result<String, String> {
  let vk = parse_hotkey(&key)?;
  hub().vk.store(vk, Ordering::Relaxed);
  hub().down.store(false, Ordering::Relaxed);
  Ok(if vk == 0 { "off".into() } else { key.trim().to_uppercase() })
}

fn parse_hotkey(key: &str) -> Result<u32, String> {
  match key.trim().to_uppercase().as_str() {
    "" | "OFF" | "NONE" => Ok(0),
    "F7" => Ok(0x76),
    "F8" => Ok(0x77),
    "F9" => Ok(0x78),
    "F10" => Ok(0x79),
    other => Err(format!("Unsupported listen key: {other}")),
  }
}

#[cfg(windows)]
fn install_hook() {
  use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
  use windows_sys::Win32::UI::WindowsAndMessaging::{GetMessageW, SetWindowsHookExW, MSG, WH_KEYBOARD_LL};

  unsafe {
    let module = GetModuleHandleW(std::ptr::null());
    let hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook_proc), module, 0);
    if hook.is_null() {
      log::warn!("Could not install the listen hotkey hook.");
      return;
    }
    let mut msg = std::mem::zeroed::<MSG>();
    while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {}
    let _ = hook;
  }
}

#[cfg(windows)]
unsafe extern "system" fn hook_proc(
  code: i32,
  wparam: windows_sys::Win32::Foundation::WPARAM,
  lparam: windows_sys::Win32::Foundation::LPARAM,
) -> windows_sys::Win32::Foundation::LRESULT {
  use windows_sys::Win32::UI::WindowsAndMessaging::CallNextHookEx;

  if code >= 0 && handle_hotkey(wparam, lparam) {
    return 1;
  }
  unsafe { CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam) }
}

#[cfg(windows)]
fn handle_hotkey(
  _wparam: windows_sys::Win32::Foundation::WPARAM,
  lparam: windows_sys::Win32::Foundation::LPARAM,
) -> bool {
  use windows_sys::Win32::UI::WindowsAndMessaging::{KBDLLHOOKSTRUCT, LLKHF_INJECTED, LLKHF_UP};

  let wanted = hub().vk.load(Ordering::Relaxed);
  if wanted == 0 {
    return false;
  }
  let info = unsafe { &*(lparam as *const KBDLLHOOKSTRUCT) };
  if info.vkCode != wanted {
    return false;
  }
  if info.flags & LLKHF_INJECTED != 0 {
    return false;
  }
  let up = info.flags & LLKHF_UP != 0;
  if up {
    if hub().down.swap(false, Ordering::Relaxed) {
      emit_hotkey("listen-hotkey-up");
    }
  } else if !hub().down.swap(true, Ordering::Relaxed) {
    emit_hotkey("listen-hotkey-down");
  }
  true
}

fn emit_hotkey(event: &str) {
  let app = hub().app.lock().ok().and_then(|slot| slot.clone());
  if let Some(app) = app {
    let _ = app.emit(event, ());
  }
}
