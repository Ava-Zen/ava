//! Grok CLI ACP host. Ported from Korg Bro (MIT), https://github.com/lynnzc/korg-bro

mod acp;
mod acp_msg;
pub mod agent_host;
mod agent_link;
mod auth;
mod grok_bin;
mod overlay;
pub(crate) mod platform;
mod session_index;
mod types;

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::grok::acp::{finish_rpc, spawn_rpc_wait, RpcWaiter};
use crate::grok::agent_host::AppState;
use crate::grok::types::{
    AuthStatus, GrokInfo, GrokUpdateCheck, ReplayPage, RosterItem, RosterSnapshot,
};

pub use agent_host::AppState as GrokAppState;

pub(crate) async fn off_thread<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| e.to_string())?
}

const EXTENSION_RPC_TIMEOUT: Duration = Duration::from_secs(5);

async fn wait_extension_rpc(waiter: RpcWaiter, method: &str) -> Result<Value, String> {
    finish_rpc(spawn_rpc_wait(waiter, method, EXTENSION_RPC_TIMEOUT)).await
}

fn begin_agent_rpc(
    state: &State<'_, Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Option<RpcWaiter>, String> {
    let mut guard = state.lock().map_err(|err| err.to_string())?;
    let Some(agent) = guard.link.agent_mut() else {
        return Ok(None);
    };
    agent.begin_request(method, params).map(Some)
}

#[tauri::command]
pub async fn which_grok() -> Result<GrokInfo, String> {
    off_thread(|| {
        grok_bin::rearm_fake();
        let bin = grok_bin::resolve_grok_bin()?;
        Ok(grok_bin::inspect(&bin))
    })
    .await
}

#[tauri::command]
pub async fn install_grok(app: AppHandle) -> Result<GrokInfo, String> {
    off_thread(move || {
        if let Ok(bin) = grok_bin::resolve_grok_bin() {
            return Ok(grok_bin::inspect(&bin));
        }
        grok_bin::install_cli(|line| {
            let _ = app.emit("grok://install", line);
        })?;
        let bin = grok_bin::resolve_grok_bin().map_err(|e| {
            format!("Installed, but grok is still not on PATH or in ~/.grok/bin. {e}")
        })?;
        Ok(grok_bin::inspect(&bin))
    })
    .await
}

#[tauri::command]
pub async fn check_grok_update() -> Result<GrokUpdateCheck, String> {
    off_thread(|| {
        let bin = grok_bin::resolve_grok_bin()?;
        grok_bin::check_update(&bin)
    })
    .await
}

#[tauri::command]
pub async fn update_grok(app: AppHandle) -> Result<GrokInfo, String> {
    off_thread(move || {
        let bin = grok_bin::resolve_grok_bin()?;
        grok_bin::update_cli(&bin, |line| {
            let _ = app.emit("grok://update", line);
        })?;
        Ok(grok_bin::inspect(&bin))
    })
    .await
}

async fn auth_status_from_agent(state: &State<'_, Mutex<AppState>>) -> Result<AuthStatus, String> {
    let waiter = begin_agent_rpc(state, "x.ai/auth/info", json!({}))?.ok_or("Agent not started")?;
    Ok(auth::status_from_info(
        &wait_extension_rpc(waiter, "x.ai/auth/info").await?,
    ))
}

#[tauri::command]
pub async fn grok_auth_status(
    app: AppHandle,
    state: State<'_, Mutex<AppState>>,
) -> Result<AuthStatus, String> {
    agent_host::start_agent(app, state.clone()).await?;
    auth_status_from_agent(&state).await
}

const LOGIN_RPC_TIMEOUT: Duration = Duration::from_secs(300);

#[tauri::command]
pub async fn grok_login(
    app: AppHandle,
    state: State<'_, Mutex<AppState>>,
) -> Result<AuthStatus, String> {
    let _operation = agent_host::operation().await;
    let caps = agent_host::start_agent_inner(app.clone(), state.clone()).await?;
    let method_id = auth::interactive_method(&caps.initialize)?;
    let authenticate = begin_agent_rpc(
        &state,
        "authenticate",
        json!({
            "methodId": method_id,
            "_meta": { "use_oauth": true, "force_interactive": true }
        }),
    )?
    .ok_or("Agent not started")?;
    let authenticate_task = spawn_rpc_wait(authenticate, "authenticate", LOGIN_RPC_TIMEOUT);

    let waiter =
        begin_agent_rpc(&state, "x.ai/auth/get_url", json!({}))?.ok_or("Agent not started")?;
    let response = finish_rpc(spawn_rpc_wait(
        waiter,
        "x.ai/auth/get_url",
        LOGIN_RPC_TIMEOUT,
    ))
    .await?;
    let url = auth::login_url(&response)?;
    let _ = app.emit("auth://login", json!({ "url": url }));
    finish_rpc(authenticate_task).await?;
    auth_status_from_agent(&state).await
}

#[tauri::command]
pub async fn grok_logout(
    app: AppHandle,
    state: State<'_, Mutex<AppState>>,
) -> Result<AuthStatus, String> {
    let _operation = agent_host::operation().await;
    agent_host::start_agent_inner(app, state.clone()).await?;
    let current = auth_status_from_agent(&state).await?;
    if !current.signed_in {
        return Ok(current);
    }
    agent_host::close_sessions_for_logout(&state).await?;
    let waiter = agent_host::begin_auth_logout_rpc(&state, json!({}))?;
    let result = wait_extension_rpc(waiter, "x.ai/auth/logout").await?;
    if result.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(result
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("x.ai/auth/logout did not confirm success")
            .to_string());
    }
    let status = require_signed_out(auth_status_from_agent(&state).await?)?;
    agent_host::drop_agent(&state)?;
    Ok(status)
}

fn require_signed_out(status: AuthStatus) -> Result<AuthStatus, String> {
    if status.signed_in {
        return Err(
            "Grok is still authenticated after logout (an API key may still be configured); agent work was resumed."
                .into(),
        );
    }
    Ok(status)
}

#[tauri::command]
pub async fn grok_cancel_login(state: State<'_, Mutex<AppState>>) -> Result<(), String> {
    let Some(waiter) = begin_agent_rpc(&state, "x.ai/auth/cancel", json!({}))? else {
        return Ok(());
    };
    let response = wait_extension_rpc(waiter, "x.ai/auth/cancel").await?;
    if response.get("cancelled").and_then(Value::as_bool) != Some(true) {
        return Err("x.ai/auth/cancel did not confirm cancellation".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn list_roster(state: State<'_, Mutex<AppState>>) -> Result<RosterSnapshot, String> {
    let waiter =
        begin_agent_rpc(&state, "x.ai/sessions/list", json!({}))?.ok_or("Agent not started")?;
    let response = wait_extension_rpc(waiter, "x.ai/sessions/list").await?;
    roster_snapshot(response, &state)
}

#[derive(Deserialize)]
struct GrokRosterResponse {
    sessions: Vec<GrokRosterEntry>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GrokRosterEntry {
    session_id: String,
    title: Option<String>,
    cwd: String,
    model_id: Option<String>,
    reasoning_effort: Option<String>,
    activity: String,
    last_turn_summary: Option<String>,
    last_change_unix_ms: i64,
}

fn roster_snapshot(
    response: Value,
    state: &State<'_, Mutex<AppState>>,
) -> Result<RosterSnapshot, String> {
    let response: GrokRosterResponse = serde_json::from_value(response)
        .map_err(|err| format!("invalid x.ai/sessions/list response: {err}"))?;
    let running_ids = response
        .sessions
        .iter()
        .filter(|row| matches!(row.activity.as_str(), "working" | "needs_input"))
        .map(|row| row.session_id.clone())
        .collect();
    let mut rows = response
        .sessions
        .into_iter()
        .map(roster_item)
        .collect::<Vec<_>>();
    overlay::decorate_roster(&mut rows);
    rows.sort_by(|a, b| match b.pinned.cmp(&a.pinned) {
        std::cmp::Ordering::Equal => b.updated_at.cmp(&a.updated_at),
        other => other,
    });
    let live_ids = state.lock().map_err(|err| err.to_string())?.link.live_ids();
    Ok(RosterSnapshot {
        rows,
        live_ids,
        running_ids,
    })
}

fn roster_title(title: Option<&str>, cwd: &str) -> String {
    let trimmed = title.map(str::trim).filter(|value| !value.is_empty());
    if let Some(title) = trimmed {
        if !title_is_cwd_folder(title, cwd) {
            return title.to_string();
        }
    }
    "Untitled".into()
}

fn title_is_cwd_folder(title: &str, cwd: &str) -> bool {
    let folder = std::path::Path::new(cwd.trim_end_matches(['/', '\\']))
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty());
    folder.is_some_and(|name| name.eq_ignore_ascii_case(title))
}

fn roster_item(row: GrokRosterEntry) -> RosterItem {
    let title = roster_title(row.title.as_deref(), &row.cwd);
    let updated_at =
        chrono::DateTime::<chrono::Utc>::from_timestamp_millis(row.last_change_unix_ms)
            .map(|time| time.to_rfc3339())
            .unwrap_or_default();
    let (color, shape) = overlay::default_session_style(&row.session_id);
    RosterItem {
        session_id: row.session_id,
        cwd: row.cwd,
        title,
        preview: row.last_turn_summary.unwrap_or_default(),
        color,
        shape,
        pinned: false,
        updated_at,
        model_id: row.model_id,
        unread: false,
        effort: row.reasoning_effort,
    }
}

#[tauri::command]
pub async fn open_replay(
    session_id: String,
    cursor: Option<u64>,
    mark_read: Option<bool>,
) -> Result<ReplayPage, String> {
    off_thread(move || {
        let dir = session_index::find_dir(&session_id)?;
        let page = session_index::replay_page(&dir, cursor)?;
        if cursor.is_none() && mark_read.unwrap_or(true) {
            let _ = overlay::mark_read(&session_id, &overlay::now_iso());
        }
        Ok(page)
    })
    .await
}

#[tauri::command]
pub fn mark_session_read(session_id: String, seen_at: String) -> Result<(), String> {
    overlay::mark_read(&session_id, &seen_at)
}

#[tauri::command]
pub fn rename_session(session_id: String, title: String) -> Result<(), String> {
    overlay::rename(&session_id, &title)
}

#[tauri::command]
pub async fn delete_session(
    app: AppHandle,
    session_id: String,
    state: State<'_, Mutex<AppState>>,
) -> Result<String, String> {
    agent_host::start_agent(app, state.clone()).await?;
    agent_host::delete_session_via_acp(&session_id, &state).await?;
    overlay::forget_session(&session_id);
    Ok("deleted".into())
}

#[tauri::command]
pub async fn duplicate_session(
    app: AppHandle,
    session_id: String,
    state: State<'_, Mutex<AppState>>,
) -> Result<String, String> {
    agent_host::start_agent(app, state.clone()).await?;
    let new_id = agent_host::fork_session_via_acp(&session_id, &state).await?;
    let title = overlay::title_override(&session_id).unwrap_or_else(|| "Untitled".into());
    let _ = overlay::rename(&new_id, &format!("{title} copy"));
    Ok(new_id)
}

#[tauri::command]
pub async fn grok_pick_folder(
    app: AppHandle,
    cwd: Option<String>,
) -> Result<Option<String>, String> {
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let mut dlg = rfd::FileDialog::new().set_title("Choose project folder");
        if let Some(dir) = cwd.as_deref().filter(|s| !s.is_empty()) {
            let path = PathBuf::from(dir);
            if path.is_dir() {
                dlg = dlg.set_directory(path);
            }
        }
        if let Some(win) = handle.get_webview_window("main") {
            dlg = dlg.set_parent(&win);
        }
        let _ = tx.send(dlg.pick_folder().map(|p| p.display().to_string()));
    })
    .map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || rx.recv().map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn grok_project_prefs() -> overlay::ProjectPrefs {
    overlay::project_prefs()
}

#[tauri::command]
pub fn grok_remember_project(path: String) -> Result<overlay::ProjectPrefs, String> {
    overlay::remember_project(&path)
}

#[tauri::command]
pub fn pin_session(session_id: String, pinned: bool) -> Result<(), String> {
    overlay::set_pinned(&session_id, pinned)
}

#[tauri::command]
pub fn grok_session_mode(session_id: String) -> String {
    overlay::session_mode(&session_id).unwrap_or_default()
}

#[tauri::command]
pub fn grok_default_mode() -> String {
    overlay::default_mode()
}

#[tauri::command]
pub fn grok_set_default_mode(mode: String) -> Result<String, String> {
    overlay::set_default_mode(&mode)
}

#[tauri::command]
pub fn grok_last_session() -> String {
    overlay::last_session()
}

#[tauri::command]
pub fn grok_remember_session(session_id: String) -> Result<(), String> {
    overlay::remember_session(&session_id)
}

#[cfg(test)]
mod policy_tests {
    use super::{require_signed_out, roster_title};
    use crate::grok::types::AuthStatus;

    #[test]
    fn logout_is_not_complete_while_an_api_key_keeps_auth_signed_in() {
        let status = AuthStatus {
            signed_in: true,
            message: "api key configured".into(),
            email: None,
            name: None,
        };
        let error = require_signed_out(status).unwrap_err();
        assert!(error.contains("still authenticated"));
        assert!(error.contains("API key"));
    }

    #[test]
    fn roster_title_keeps_a_generated_name() {
        assert_eq!(
            roster_title(Some("Fix thinking status"), "/Users/me/project"),
            "Fix thinking status"
        );
    }

    #[test]
    fn roster_title_does_not_use_the_cwd_folder_while_untitled() {
        assert_eq!(roster_title(None, "/Users/me/project"), "Untitled");
        assert_eq!(roster_title(Some("   "), "/tmp/project/"), "Untitled");
        assert_eq!(
            roster_title(Some("project"), "/Users/me/project"),
            "Untitled"
        );
        assert_eq!(roster_title(Some("project"), "/tmp/other"), "project");
    }
}
