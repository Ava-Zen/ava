use std::{env, fs, io, path::Path};

use tauri::Manager;

mod copilot;
mod llm;
mod mcp;
mod voice_session;

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

fn title_case_name_part(part: &str) -> String {
  let mut chars = part.chars();
  match chars.next() {
    Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
    None => String::new(),
  }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_http::init())
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_deep_link::init())
    .manage(llm::NativeLlm::default())
    .manage(copilot::CopilotHost::default())
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
        app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
        app.handle().plugin(tauri_plugin_process::init())?;

        use tauri_plugin_deep_link::DeepLinkExt;
        let _ = app.deep_link().register_all();

        // Host the MCP TTS server on desktop so other local agents can borrow Ava's voice.
        mcp::start(app.handle().clone());
      }

      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      suggested_user_name,
      xai_read_grok_cli_auth,
      write_file_bytes,
      reset_app_cache,
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
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
