use serde::Deserialize;
use tauri::{LogicalPosition, LogicalSize, WebviewWindow};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionChrome {
  compact: bool,
  always_on_top: bool,
  width: f64,
  height: f64,
  clip_orb: bool,
  x: Option<f64>,
  y: Option<f64>,
}

#[tauri::command]
pub fn set_companion_chrome(window: WebviewWindow, chrome: CompanionChrome) -> Result<(), String> {
  window
    .set_always_on_top(chrome.always_on_top)
    .map_err(|error| error.to_string())?;

  if chrome.compact {
    let _ = window.unmaximize();
    window
      .set_decorations(false)
      .map_err(|error| error.to_string())?;
    let _ = window.set_shadow(false);
    window
      .set_resizable(false)
      .map_err(|error| error.to_string())?;
    set_windows_orb_frame(&window, true)?;
    window
      .set_min_size(Some(LogicalSize::new(120.0, 120.0)))
      .map_err(|error| error.to_string())?;
    window
      .set_size(LogicalSize::new(chrome.width.max(120.0), chrome.height.max(120.0)))
      .map_err(|error| error.to_string())?;
    apply_orb_clip(&window, chrome.clip_orb)?;
  } else {
    apply_orb_clip(&window, false)?;
    set_windows_orb_frame(&window, false)?;
    window
      .set_decorations(true)
      .map_err(|error| error.to_string())?;
    let _ = window.set_shadow(true);
    window
      .set_resizable(true)
      .map_err(|error| error.to_string())?;
    window
      .set_min_size(Some(LogicalSize::new(360.0, 600.0)))
      .map_err(|error| error.to_string())?;
    if chrome.width >= 360.0 && chrome.height >= 600.0 {
      window
        .set_size(LogicalSize::new(chrome.width, chrome.height))
        .map_err(|error| error.to_string())?;
    }
    if let (Some(x), Some(y)) = (chrome.x, chrome.y) {
      let _ = window.set_position(LogicalPosition::new(x, y));
    }
  }

  Ok(())
}

#[tauri::command]
pub fn start_window_drag(window: WebviewWindow) -> Result<(), String> {
  window.start_dragging().map_err(|error| error.to_string())
}

fn apply_orb_clip(window: &WebviewWindow, clip: bool) -> Result<(), String> {
  #[cfg(windows)]
  {
    apply_windows_orb_clip(window, clip)
  }
  #[cfg(not(windows))]
  {
    let _ = (window, clip);
    Ok(())
  }
}

fn set_windows_orb_frame(window: &WebviewWindow, compact: bool) -> Result<(), String> {
  #[cfg(windows)]
  {
    set_windows_orb_frame_inner(window, compact)
  }
  #[cfg(not(windows))]
  {
    let _ = (window, compact);
    Ok(())
  }
}

#[cfg(windows)]
fn set_windows_orb_frame_inner(window: &WebviewWindow, compact: bool) -> Result<(), String> {
  use windows_sys::Win32::Graphics::Dwm::{
    DwmExtendFrameIntoClientArea, DwmSetWindowAttribute, DWMNCRP_DISABLED, DWMNCRP_USEWINDOWSTYLE,
    DWMWA_NCRENDERING_POLICY, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_DEFAULT, DWMWCP_DONOTROUND,
  };
  use windows_sys::Win32::UI::Controls::MARGINS;
  use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetWindowLongW, SetWindowLongW, SetWindowPos, GWL_STYLE, SWP_FRAMECHANGED, SWP_NOACTIVATE,
    SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, WS_CAPTION, WS_MAXIMIZEBOX, WS_MINIMIZEBOX, WS_SYSMENU,
    WS_THICKFRAME,
  };

  let hwnd = window.hwnd().map_err(|error| error.to_string())?;
  let handle = hwnd.0 as _;
  const CAPTION: u32 =
    WS_CAPTION | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_SYSMENU;

  unsafe {
    let mut style = GetWindowLongW(handle, GWL_STYLE) as u32;
    if compact {
      style &= !CAPTION;
    } else {
      style |= CAPTION;
    }
    SetWindowLongW(handle, GWL_STYLE, style as i32);
    SetWindowPos(
      handle,
      std::ptr::null_mut(),
      0,
      0,
      0,
      0,
      SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
    );

    let policy: i32 = if compact {
      DWMNCRP_DISABLED
    } else {
      DWMNCRP_USEWINDOWSTYLE
    };
    let _ = DwmSetWindowAttribute(
      handle,
      DWMWA_NCRENDERING_POLICY as u32,
      (&policy as *const i32).cast(),
      std::mem::size_of::<i32>() as u32,
    );

    let corners: i32 = if compact {
      DWMWCP_DONOTROUND
    } else {
      DWMWCP_DEFAULT
    };
    let _ = DwmSetWindowAttribute(
      handle,
      DWMWA_WINDOW_CORNER_PREFERENCE as u32,
      (&corners as *const i32).cast(),
      std::mem::size_of::<i32>() as u32,
    );

    let margins = MARGINS {
      cxLeftWidth: 0,
      cxRightWidth: 0,
      cyTopHeight: 0,
      cyBottomHeight: 0,
    };
    let _ = DwmExtendFrameIntoClientArea(handle, &margins);
  }
  Ok(())
}

#[cfg(windows)]
fn apply_windows_orb_clip(window: &WebviewWindow, clip: bool) -> Result<(), String> {
  use windows_sys::Win32::Foundation::RECT;
  use windows_sys::Win32::Graphics::Gdi::{CreateEllipticRgn, DeleteObject, SetWindowRgn};
  use windows_sys::Win32::UI::WindowsAndMessaging::GetWindowRect;

  let hwnd = window.hwnd().map_err(|error| error.to_string())?;
  let handle = hwnd.0 as _;
  if !clip {
    unsafe {
      SetWindowRgn(handle, std::ptr::null_mut(), 1);
    }
    return Ok(());
  }

  let (width, height) = unsafe {
    let mut rect = RECT {
      left: 0,
      top: 0,
      right: 0,
      bottom: 0,
    };
    if GetWindowRect(handle, &mut rect) == 0 {
      let size = window.outer_size().map_err(|error| error.to_string())?;
      (size.width as i32, size.height as i32)
    } else {
      (rect.right - rect.left, rect.bottom - rect.top)
    }
  };
  if width < 32 || height < 32 {
    return Ok(());
  }

  unsafe {
    let region = CreateEllipticRgn(0, 0, width, height);
    if region.is_null() {
      return Err("Could not shape the orb window.".into());
    }
    if SetWindowRgn(handle, region, 1) == 0 {
      DeleteObject(region as _);
      return Err("Could not apply the orb window shape.".into());
    }
  }
  Ok(())
}
