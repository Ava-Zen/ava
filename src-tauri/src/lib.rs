use std::{env, fs, io, path::Path};

use tauri::Manager;

mod copilot;
mod home;
mod llm;
mod mcp;
mod voice_session;

#[cfg(desktop)]
mod grok;

#[cfg(desktop)]
mod self_improve;

#[tauri::command]
fn mcp_tts_complete(bridge: tauri::State<mcp::McpBridge>, id: u64, ok: bool) {
  bridge.complete(id, ok);
}

#[tauri::command]
fn mcp_server_info() -> serde_json::Value {
  serde_json::json!({
    "url": format!("http://127.0.0.1:{}", mcp::MCP_PORT),
    "port": mcp::MCP_PORT,
  })
}

#[tauri::command]
fn suggested_user_name() -> Option<String> {
  [
    "AVA_USER_NAME",
    "USER_FULL_NAME",
    "FULLNAME",
    "NAME",
    "USERNAME",
    "USER",
    "LOGNAME",
  ]
  .into_iter()
  .filter_map(|key| env::var(key).ok())
  .find_map(|raw| normalize_name_guess(&raw))
  .or_else(|| {
    env::var("USERPROFILE")
      .or_else(|_| env::var("HOME"))
      .ok()
      .and_then(|path| path.rsplit(['\\', '/']).next().map(str::to_string))
      .and_then(|raw| normalize_name_guess(&raw))
  })
}

#[tauri::command]
fn xai_read_grok_cli_auth() -> Option<String> {
  let home = env::var("USERPROFILE")
    .or_else(|_| env::var("HOME"))
    .ok()?;
  let path = std::path::Path::new(&home).join(".grok").join("auth.json");
  fs::read_to_string(path).ok().filter(|raw| !raw.trim().is_empty())
}

#[tauri::command]
fn write_file_bytes(path: String, contents: Vec<u8>) -> Result<String, String> {
  let dest = Path::new(&path);
  if path.trim().is_empty() {
    return Err("Missing file path.".into());
  }
  if let Some(parent) = dest.parent() {
    if !parent.as_os_str().is_empty() {
      fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
  }
  fs::write(dest, contents).map_err(|error| error.to_string())?;
  Ok(dest.display().to_string())
}

#[tauri::command]
fn reset_app_cache(app: tauri::AppHandle) -> Result<(), String> {
  let mut targets = Vec::new();

  if let Ok(path) = app.path().app_cache_dir() {
    targets.push(path);
  }
  if let Ok(path) = app.path().app_local_data_dir() {
    targets.push(path);
  }

  for target in targets {
    if !target.exists() {
      continue;
    }

    match fs::remove_dir_all(&target) {
      Ok(()) => {}
      Err(error) if error.kind() == io::ErrorKind::NotFound => {}
      Err(error) => {
        log::warn!("Failed to remove cache path {}: {}", target.display(), error);
      }
    }
  }

  Ok(())
}

fn normalize_name_guess(raw: &str) -> Option<String> {
  let trimmed = raw.trim();
  if trimmed.is_empty() || trimmed.len() > 80 {
    return None;
  }

  let last_segment = trimmed
    .rsplit(['\\', '/'])
    .next()
    .unwrap_or(trimmed)
    .trim();

  let cleaned = last_segment
    .split(['.', '_', '-', '+'])
    .filter(|part| !part.trim().is_empty())
    .map(title_case_name_part)
    .collect::<Vec<_>>()
    .join(" ");

  if cleaned.len() < 2 || cleaned.chars().any(|c| c.is_ascii_digit()) {
    return None;
  }

  let lowercase = cleaned.to_ascii_lowercase();
  if matches!(
    lowercase.as_str(),
    "user" | "admin" | "administrator" | "default" | "public" | "desktop" | "owner"
  ) {
    return None;
  }

  Some(cleaned)
}

#[cfg(desktop)]
fn open_debug_window_inner(app: &tauri::AppHandle) -> Result<(), String> {
  if let Some(existing) = app.get_webview_window("debug") {
    let _ = existing.show();
    let _ = existing.set_focus();
    return Ok(());
  }

  if !cfg!(debug_assertions) {
    return Err("Debug window is only available in debug builds.".into());
  }

  let config = app.config();
  let window_cfg = config
    .app
    .windows
    .iter()
    .find(|window| window.label == "debug")
    .ok_or_else(|| "debug window is not configured".to_string())?;
  tauri::WebviewWindowBuilder::from_config(app, window_cfg)
    .map_err(|error| error.to_string())?
    .build()
    .map_err(|error| error.to_string())?;
  Ok(())
}

#[cfg(desktop)]
#[tauri::command]
async fn open_debug_window(app: tauri::AppHandle) -> Result<(), String> {
  open_debug_window_inner(&app)
}

fn title_case_name_part(part: &str) -> String {
  let mut chars = part.chars();
  match chars.next() {
    Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
    None => String::new(),
  }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let builder = tauri::Builder::default()
    .plugin(tauri_plugin_http::init())
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_deep_link::init())
    .manage(llm::NativeLlm::default())
    .manage(copilot::CopilotHost::default());

  #[cfg(desktop)]
  let builder = builder.manage(std::sync::Mutex::new(grok::GrokAppState::default()));

  #[cfg(desktop)]
  let builder = builder.plugin(
    tauri_plugin_window_state::Builder::default()
      .with_filter(|label| label == "main")
      .build(),
  );

  let builder = builder
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      // Register the custom URL scheme(s) so OAuth redirects come back to Ava.
      // On Windows/Linux this also enables the scheme during development.
      #[cfg(desktop)]
      {
        if self_improve::hop_to_live_if_needed(&app.handle()) {
          std::process::exit(0);
        }
        grok::platform::init();
        app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
        app.handle().plugin(tauri_plugin_process::init())?;

        use tauri_plugin_deep_link::DeepLinkExt;
        let _ = app.deep_link().register_all();

        // Host the MCP TTS server on desktop so other local agents can borrow Ava's voice.
        mcp::start(app.handle().clone());

        if cfg!(debug_assertions) {
          if let Err(error) = open_debug_window_inner(app.handle()) {
            log::warn!("Could not open debug window: {error}");
          }
        }
      }

      Ok(())
    });

  #[cfg(desktop)]
  let builder = builder.invoke_handler(tauri::generate_handler![
    suggested_user_name,
    xai_read_grok_cli_auth,
    write_file_bytes,
    reset_app_cache,
    open_debug_window,
    home::home_pick_folder,
    home::home_suggested_path,
    home::home_ensure,
    home::home_read_text,
    home::home_write_text,
    home::home_list,
    home::home_open,
    mcp_tts_complete,
    mcp_server_info,
    copilot::copilot_status,
    copilot::copilot_read_gh_auth,
    copilot::copilot_pick_folder,
    copilot::copilot_run_task,
    copilot::copilot_abort,
    llm::llm_native_status,
    llm::llm_load_model,
    llm::llm_generate,
    llm::llm_cancel,
    llm::llm_list_models,
    llm::llm_open_models_dir,
    llm::llm_delete_model,
    llm::web_model_cache_ensure,
    voice_session::voice_session_start,
    voice_session::voice_session_stop,
    grok::which_grok,
    grok::install_grok,
    grok::check_grok_update,
    grok::update_grok,
    grok::grok_auth_status,
    grok::grok_login,
    grok::grok_logout,
    grok::grok_cancel_login,
    grok::list_roster,
    grok::open_replay,
    grok::mark_session_read,
    grok::rename_session,
    grok::delete_session,
    grok::duplicate_session,
    grok::agent_host::start_agent,
    grok::agent_host::stop_agent,
    grok::agent_host::take_over_session,
    grok::agent_host::send_prompt,
    grok::agent_host::queue_control,
    grok::agent_host::cancel_turn,
    grok::agent_host::respond_agent_request,
    grok::agent_host::agent_caps,
    grok::grok_pick_folder,
    grok::grok_project_prefs,
    grok::grok_remember_project,
    grok::agent_host::new_session,
    grok::pin_session,
    grok::agent_host::set_session_model,
    grok::agent_host::set_session_mode,
    grok::grok_session_mode,
    grok::grok_default_mode,
    grok::grok_set_default_mode,
    grok::grok_last_session,
    grok::grok_remember_session,
    self_improve::self_improve_status,
    self_improve::self_improve_ensure_source,
    self_improve::self_improve_arm,
    self_improve::self_improve_reset,
    self_improve::self_improve_apply
  ]);

  #[cfg(not(desktop))]
  let builder = builder.invoke_handler(tauri::generate_handler![
    suggested_user_name,
    xai_read_grok_cli_auth,
    write_file_bytes,
    reset_app_cache,
    home::home_pick_folder,
    home::home_suggested_path,
    home::home_ensure,
    home::home_read_text,
    home::home_write_text,
    home::home_list,
    home::home_open,
    mcp_tts_complete,
    mcp_server_info,
    copilot::copilot_status,
    copilot::copilot_read_gh_auth,
    copilot::copilot_pick_folder,
    copilot::copilot_run_task,
    copilot::copilot_abort,
    llm::llm_native_status,
    llm::llm_load_model,
    llm::llm_generate,
    llm::llm_cancel,
    llm::llm_list_models,
    llm::llm_open_models_dir,
    llm::llm_delete_model,
    llm::web_model_cache_ensure,
    voice_session::voice_session_start,
    voice_session::voice_session_stop
  ]);

  builder
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
