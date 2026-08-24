use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::grok::acp::{wait_rpc, AcpAgent, RpcWaiter};
use crate::grok::acp_msg::{self, Incoming};
use crate::grok::agent_link::{AgentLink, LinkEvent};
use crate::grok::grok_bin;
use crate::grok::off_thread;
use crate::grok::overlay;
use crate::grok::types::{AgentCaps, AgentRequestEvent};

pub struct AppState {
    pub bin: Option<PathBuf>,
    pub grok_home: PathBuf,
    pub caps: Option<AgentCaps>,
    pub link: AgentLink,
    pub pumping: bool,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            bin: None,
            grok_home: grok_bin::grok_home(),
            caps: None,
            link: AgentLink::new(),
            pumping: false,
        }
    }
}

impl AppState {
    fn invalidate_agent(&mut self) {
        self.caps = None;
        self.link.drop_all();
    }
}

static AGENT_OPERATION: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

/// The one mutation lane for the shared Grok proxy. It serializes lifecycle,
/// session, queue, auth, and extension mutations without adding parallel epoch
/// state to `AppState`; the event pump remains independent so RPC replies flow.
pub async fn operation() -> tokio::sync::MutexGuard<'static, ()> {
    AGENT_OPERATION
        .get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await
}

#[tauri::command]
pub async fn start_agent(
    app: AppHandle,
    state: State<'_, Mutex<AppState>>,
) -> Result<AgentCaps, String> {
    let _operation = operation().await;
    start_agent_inner(app, state).await
}

pub(crate) async fn start_agent_inner(
    app: AppHandle,
    state: State<'_, Mutex<AppState>>,
) -> Result<AgentCaps, String> {
    {
        let mut guard = state.lock().map_err(|e| e.to_string())?;
        if guard.link.has_live() {
            if let Some(caps) = &guard.caps {
                return Ok(caps.clone());
            }
        }
    }
    let bin = grok_bin::resolve_grok_bin()?;
    let grok_home = grok_bin::grok_home();
    let wake = state.lock().ok().map(|guard| guard.link.wake());
    let _ = app.emit("acp://connecting", json!({ "phase": "spawn" }));
    let bin_spawn = bin.clone();
    let (agent, initialize) = off_thread(move || {
        let mut agent = AcpAgent::spawn(&bin_spawn, wake)?;
        // A swallowed handshake failure looks like a healthy agent and turns
        // every later session/load into a 45s timeout instead.
        let initialize = agent.initialize()?;
        Ok((agent, initialize))
    })
    .await?;
    let caps = AgentCaps {
        initialize,
        live_acp_allowed: true,
        blocked_reason: None,
    };
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    guard.link.attach(agent);
    guard.bin = Some(bin);
    guard.grok_home = grok_home;
    guard.caps = Some(caps.clone());
    let start_pump = !guard.pumping;
    if start_pump {
        guard.pumping = true;
    }
    drop(guard);
    if start_pump {
        pump_events(app.clone());
    }
    let _ = app.emit("acp://connecting", json!({ "phase": "ready" }));
    Ok(caps)
}

#[tauri::command]
pub async fn stop_agent(state: State<'_, Mutex<AppState>>) -> Result<(), String> {
    let _operation = operation().await;
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    guard.invalidate_agent();
    Ok(())
}

const LOGOUT_CLOSE_TIMEOUT: Duration = Duration::from_secs(10);

/// Close every session loaded through this proxy before clearing auth. The
/// caller owns the global operation lane, so no second gate or epoch is needed.
pub async fn close_sessions_for_logout(state: &State<'_, Mutex<AppState>>) -> Result<(), String> {
    let loaded = state.lock().map_err(|err| err.to_string())?.link.live_ids();
    for session_id in loaded {
        let waiter = state
            .lock()
            .map_err(|err| err.to_string())?
            .link
            .agent_mut()
            .ok_or("Agent stopped before sessions could close")?
            .begin_request("x.ai/session/close", json!({ "sessionId": session_id }))?;
        let response = wait_rpc(waiter, "x.ai/session/close", LOGOUT_CLOSE_TIMEOUT).await?;
        validate_logout_close(&session_id, &response)?;
        state
            .lock()
            .map_err(|err| err.to_string())?
            .link
            .drop_session_no_reconnect(&session_id);
    }
    Ok(())
}

fn validate_logout_close(session_id: &str, response: &Value) -> Result<(), String> {
    if response.get("success").and_then(Value::as_bool) != Some(true) {
        return Err(format!(
            "x.ai/session/close did not confirm success for {session_id}"
        ));
    }
    match response.get("outcome").and_then(Value::as_str) {
        Some("closed" | "notResident") => Ok(()),
        Some("superseded") => Err(format!(
            "session {session_id} was replaced while logout was closing it"
        )),
        Some(outcome) => Err(format!(
            "x.ai/session/close returned unknown outcome {outcome:?} for {session_id}"
        )),
        None => Err(format!(
            "x.ai/session/close omitted its outcome for {session_id}"
        )),
    }
}

pub fn begin_auth_logout_rpc(
    state: &State<'_, Mutex<AppState>>,
    params: Value,
) -> Result<RpcWaiter, String> {
    let mut guard = state.lock().map_err(|err| err.to_string())?;
    guard
        .link
        .agent_mut()
        .ok_or("Agent not started")?
        .begin_request("x.ai/auth/logout", params)
}

pub fn drop_agent(state: &State<'_, Mutex<AppState>>) -> Result<(), String> {
    let mut guard = state.lock().map_err(|err| err.to_string())?;
    guard.invalidate_agent();
    Ok(())
}

#[tauri::command]
pub async fn take_over_session(
    session_id: String,
    cwd: String,
    state: State<'_, Mutex<AppState>>,
) -> Result<(), String> {
    let _operation = operation().await;
    {
        let guard = state.lock().map_err(|e| e.to_string())?;
        let caps = guard.caps.as_ref().ok_or("Agent not started")?;
        if !caps.live_acp_allowed {
            return Err(caps
                .blocked_reason
                .clone()
                .unwrap_or_else(|| "Live ACP is blocked for this machine.".into()));
        }
        if guard.link.contains(&session_id) {
            return Ok(());
        }
    }
    load_session_wait(&state, session_id, cwd).await
}

#[tauri::command]
pub async fn send_prompt(
    session_id: String,
    text: String,
    send_now: Option<bool>,
    prompt_id: Option<String>,
    state: State<'_, Mutex<AppState>>,
) -> Result<(), String> {
    let _operation = operation().await;
    let (allowed, already) = {
        let guard = state.lock().map_err(|e| e.to_string())?;
        (
            guard
                .caps
                .as_ref()
                .map(|c| c.live_acp_allowed)
                .unwrap_or(false),
            guard.link.contains(&session_id),
        )
    };
    if !allowed {
        return Err("Live ACP is blocked".into());
    }
    if !already {
        let cwd = session_cwd_via_acp(&session_id, &state).await?;
        load_session_wait(&state, session_id.clone(), cwd).await?;
    }
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    if !guard.link.has_live() {
        return Err("Agent exited".into());
    }
    let send_now = send_now.unwrap_or(false);
    let mode = overlay::effective_mode(&session_id);
    let meta = acp_msg::stamp_prompt_meta(
        overlay::permission_meta(&mode),
        prompt_id.as_deref(),
        send_now,
    );
    let sent = {
        let (_, agent) = guard
            .link
            .with_session(&session_id)
            .ok_or("Agent not started")?;
        agent.send_rpc(
            "session/prompt",
            acp_msg::session_prompt_params(&session_id, &text, meta),
        )
    };
    match sent {
        Err(err) => return Err(err),
        Ok(rpc_id) => guard.link.note_prompt(&session_id, rpc_id),
    }
    Ok(())
}

/// Grok TUI queue controls (`x.ai/queue/edit` and friends) are notifications.
#[tauri::command]
pub async fn queue_control(
    session_id: String,
    method: String,
    params: Value,
    state: State<'_, Mutex<AppState>>,
) -> Result<(), String> {
    let _operation = operation().await;
    if !acp_msg::is_queue_control_method(&method) {
        return Err(format!("unsupported queue method: {method}"));
    }
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    let (_, agent) = guard
        .link
        .with_session(&session_id)
        .ok_or("Agent not started")?;
    agent.send_notification(&method, acp_msg::stamp_queue_owner(params))
}

pub async fn delete_session_via_acp(
    session_id: &str,
    state: &State<'_, Mutex<AppState>>,
) -> Result<(), String> {
    let _operation = operation().await;
    let cwd = session_cwd_via_acp(session_id, state).await?;
    let waiter = {
        let mut guard = state.lock().map_err(|e| e.to_string())?;
        guard
            .link
            .agent_mut()
            .ok_or("Agent not started")?
            .begin_request(
                "x.ai/session/delete",
                acp_msg::session_delete_params(session_id, Some(&cwd)),
            )?
    };
    let result = wait_rpc(waiter, "x.ai/session/delete", Duration::from_secs(15)).await?;
    if result.get("success").and_then(Value::as_bool) != Some(true) {
        return Err("Grok did not delete the session".into());
    }
    if let Ok(mut guard) = state.lock() {
        guard.link.drop_session_no_reconnect(session_id);
    }
    Ok(())
}

pub async fn fork_session_via_acp(
    source_session_id: &str,
    state: &State<'_, Mutex<AppState>>,
) -> Result<String, String> {
    let _operation = operation().await;
    let cwd = session_cwd_via_acp(source_session_id, state).await?;
    let waiter = {
        let mut guard = state.lock().map_err(|e| e.to_string())?;
        guard
            .link
            .agent_mut()
            .ok_or("Agent not started")?
            .begin_request(
                "x.ai/session/fork",
                acp_msg::session_fork_params(source_session_id, &cwd, &cwd),
            )?
    };
    let result = wait_rpc(waiter, "x.ai/session/fork", Duration::from_secs(45)).await?;
    result
        .get("newSessionId")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "x.ai/session/fork did not return newSessionId".into())
}

/// Resolve mutation context from the current leader roster. Callers already
/// own the one operation lane; this helper deliberately does not lock it again.
pub(crate) async fn session_cwd_via_acp(
    session_id: &str,
    state: &State<'_, Mutex<AppState>>,
) -> Result<String, String> {
    let waiter = {
        let mut guard = state.lock().map_err(|e| e.to_string())?;
        guard
            .link
            .agent_mut()
            .ok_or("Agent not started")?
            .begin_request("x.ai/sessions/list", json!({}))?
    };
    let roster = wait_rpc(waiter, "x.ai/sessions/list", Duration::from_secs(15)).await?;
    session_cwd_from_roster(&roster, session_id)
}

fn session_cwd_from_roster(roster: &Value, session_id: &str) -> Result<String, String> {
    let sessions = roster
        .get("sessions")
        .and_then(Value::as_array)
        .ok_or("invalid x.ai/sessions/list response: sessions must be an array")?;
    let row = sessions
        .iter()
        .find(|row| row.get("sessionId").and_then(Value::as_str) == Some(session_id))
        .ok_or_else(|| format!("session {session_id} not found in x.ai/sessions/list"))?;
    let cwd = row
        .get("cwd")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("session {session_id} has no cwd in x.ai/sessions/list"))?;
    if cwd.trim().is_empty() {
        return Err(format!(
            "session {session_id} has no cwd in x.ai/sessions/list"
        ));
    }
    Ok(cwd.to_string())
}

async fn load_session_wait(
    state: &State<'_, Mutex<AppState>>,
    session_id: String,
    cwd: String,
) -> Result<(), String> {
    let waiter = {
        let mut guard = state.lock().map_err(|e| e.to_string())?;
        if guard.link.contains(&session_id) {
            return Ok(());
        }
        let mode = overlay::effective_mode(&session_id);
        let params =
            acp_msg::session_load_params(&session_id, &cwd, overlay::permission_meta(&mode));
        let waiter = guard
            .link
            .agent_mut()
            .ok_or("Agent not started")?
            .begin_request("session/load", params)?;
        waiter
    };
    wait_rpc(waiter, "session/load", Duration::from_secs(45)).await?;
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    if !guard.link.contains(&session_id) {
        guard.link.insert(session_id, cwd);
    }
    Ok(())
}

#[tauri::command]
pub async fn cancel_turn(
    session_id: String,
    cancel_trigger: Option<String>,
    state: State<'_, Mutex<AppState>>,
) -> Result<(), String> {
    let _operation = operation().await;
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    cancel_turn_on(&mut guard.link, &session_id, cancel_trigger.as_deref())
}

fn cancel_turn_on(
    link: &mut AgentLink,
    session_id: &str,
    cancel_trigger: Option<&str>,
) -> Result<(), String> {
    if !link.contains(session_id) {
        return Ok(());
    }
    interrupt_loaded_turn(link, session_id, cancel_trigger)
}

/// `_meta.cancelSubagents` makes Grok tear down the subagent tree itself,
/// so there is no per-child cancel to fan out here.
fn interrupt_loaded_turn(
    link: &mut AgentLink,
    session_id: &str,
    cancel_trigger: Option<&str>,
) -> Result<(), String> {
    let (_, agent) = link.with_session(session_id).ok_or("Agent not started")?;
    agent.cancel_session(session_id, cancel_trigger)
}

#[tauri::command]
pub async fn respond_agent_request(
    request_id: Value,
    option_id: Option<String>,
    answers: Option<Value>,
    payload: Option<Value>,
    state: State<'_, Mutex<AppState>>,
) -> Result<(), String> {
    let _operation = operation().await;
    if request_id.is_null() {
        return Ok(());
    }
    let guard = state.lock().map_err(|e| e.to_string())?;
    let result = if let Some(payload) = payload {
        payload
    } else if let Some(answers) = answers {
        json!({
            "outcome": { "outcome": "selected", "optionId": option_id },
            "answers": answers
        })
    } else {
        match option_id {
            Some(id) => json!({ "outcome": { "outcome": "selected", "optionId": id } }),
            None => json!({ "outcome": { "outcome": "cancelled" } }),
        }
    };
    // One link means one place the reply can go, so the request id needs no
    // session lookup to route it.
    guard.link.respond(request_id, result)
}

#[tauri::command]
pub fn agent_caps(state: State<Mutex<AppState>>) -> Option<AgentCaps> {
    state.lock().ok().and_then(|g| g.caps.clone())
}

#[tauri::command]
pub async fn set_session_model(
    session_id: String,
    model_id: String,
    effort: Option<String>,
    state: State<'_, Mutex<AppState>>,
) -> Result<(), String> {
    let _operation = operation().await;
    let already = {
        let guard = state.lock().map_err(|e| e.to_string())?;
        guard.link.contains(&session_id)
    };
    if !already {
        let cwd = session_cwd_via_acp(&session_id, &state).await?;
        load_session_wait(&state, session_id.clone(), cwd).await?;
    }
    let rx = {
        let mut guard = state.lock().map_err(|e| e.to_string())?;
        let mut params = json!({
            "sessionId": session_id,
            "modelId": model_id
        });
        if let Some(level) = &effort {
            params["_meta"] = json!({ "reasoningEffort": level });
        }
        let (_, agent) = guard
            .link
            .with_session(&session_id)
            .ok_or("Agent not started")?;
        agent.begin_request("session/set_model", params)?
    };
    // Grok applies the effort from `_meta.reasoningEffort` on this same call.
    wait_rpc(rx, "session/set_model", Duration::from_secs(8)).await?;
    Ok(())
}

/// Korg's picker carries permission mode and session mode at once. Permission
/// rides `_meta` on the next prompt; `plan` needs ACP `session/set_mode` now,
/// otherwise the agent never leaves the default mode.
#[tauri::command]
pub async fn set_session_mode(
    session_id: String,
    mode: String,
    state: State<'_, Mutex<AppState>>,
) -> Result<String, String> {
    let _operation = operation().await;
    let mode = overlay::normalize_mode_preference(&mode);
    let rx = {
        let mut guard = state.lock().map_err(|e| e.to_string())?;
        let params = acp_msg::session_set_mode_params(&session_id, overlay::session_mode_id(&mode));
        let (_, agent) = guard.link.with_session(&session_id).ok_or_else(|| {
            "Session is not loaded; select it before changing its mode".to_string()
        })?;
        agent.begin_request("session/set_mode", params)?
    };
    wait_rpc(rx, "session/set_mode", Duration::from_secs(8)).await?;
    let persist = overlay::set_session_mode(&session_id, &mode);
    let (mode, _) = keep_remote_commit(mode, "persisting Korg mode preference", persist);
    Ok(mode)
}

fn begin_session_mode(
    link: &mut AgentLink,
    session_id: &str,
    mode: &str,
) -> Result<Option<RpcWaiter>, String> {
    let mode_id = overlay::session_mode_id(mode);
    if mode_id == "default" {
        return Ok(None);
    }
    if let Some((_, agent)) = link.with_session(session_id) {
        return agent
            .begin_request(
                "session/set_mode",
                acp_msg::session_set_mode_params(session_id, mode_id),
            )
            .map(Some);
    }
    Ok(None)
}

async fn open_new_session(
    state: &State<'_, Mutex<AppState>>,
    params: Value,
) -> Result<Value, String> {
    let rx = {
        let mut guard = state.lock().map_err(|e| e.to_string())?;
        guard
            .link
            .agent_mut()
            .ok_or("Agent not started")?
            .begin_request("session/new", params)?
    };
    wait_rpc(rx, "session/new", Duration::from_secs(45)).await
}

fn created_session_id(created: &Value) -> Option<String> {
    created
        .get("sessionId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

/// Once Grok has committed a mutation, a Korg-only follow-up may warn but may
/// not turn that remote success into an error that invites a duplicate retry.
fn keep_remote_commit<T>(value: T, label: &str, follow_up: Result<(), String>) -> (T, bool) {
    match follow_up {
        Ok(()) => (value, true),
        Err(err) => {
            eprintln!("[ava] {label} failed after remote commit: {err}");
            (value, false)
        }
    }
}

#[tauri::command]
pub async fn new_session(
    cwd: Option<String>,
    mode: Option<String>,
    state: State<'_, Mutex<AppState>>,
) -> Result<String, String> {
    let _operation = operation().await;
    let dir = cwd
        .filter(|cwd| !cwd.trim().is_empty())
        .ok_or("Select a workspace first")?;
    let mode = mode
        .as_deref()
        .filter(|row| !row.trim().is_empty())
        .map(|row| row.to_string())
        .unwrap_or_else(overlay::default_mode);
    let created = open_new_session(
        &state,
        json!({
            "cwd": dir,
            "mcpServers": [],
            "_meta": acp_msg::stamp_client_id(overlay::permission_meta(&mode))
        }),
    )
    .await?;
    let session_id =
        created_session_id(&created).ok_or("session/new did not return a session id")?;
    let mode_follow_up = match state.lock() {
        Ok(mut guard) => {
            guard.link.insert(session_id.clone(), dir);
            begin_session_mode(&mut guard.link, &session_id, &mode)
        }
        Err(err) => Err(err.to_string()),
    };
    let mode_follow_up = match mode_follow_up {
        Ok(Some(waiter)) => wait_rpc(waiter, "session/set_mode", Duration::from_secs(8))
            .await
            .map(|_| ()),
        Ok(None) => Ok(()),
        Err(err) => Err(err),
    };
    let (session_id, mode_applied) = keep_remote_commit(
        session_id,
        "applying the requested mode to the new session",
        mode_follow_up,
    );
    if mode_applied {
        let persist = overlay::set_session_mode(&session_id, &mode);
        let ((), _) = keep_remote_commit((), "persisting Korg mode preference", persist);
    }
    Ok(session_id)
}

fn pump_events(app: AppHandle) {
    thread::spawn(move || loop {
        let event = {
            let Some(state) = app.try_state::<Mutex<AppState>>() else {
                break;
            };
            let Ok(mut guard) = state.lock() else {
                thread::sleep(Duration::from_millis(50));
                continue;
            };
            match guard.link.poll() {
                Some(event) => Some(event),
                None => {
                    let wake = guard.link.wake();
                    drop(guard);
                    wake.wait_timeout(Duration::from_millis(200));
                    None
                }
            }
        };
        let Some(event) = event else {
            continue;
        };
        match event {
            LinkEvent::Gone {
                session_id,
                no_reconnect,
            } => {
                let _ = app.emit(
                    "acp://exited",
                    json!({
                        "reason": if no_reconnect { "evicted" } else { "process" },
                        "sessionId": session_id
                    }),
                );
                continue;
            }
            LinkEvent::Msg(msg) => handle_agent_msg(&app, msg),
        }
    });
}

fn handle_agent_msg(app: &AppHandle, msg: Value) {
    // Grok tags session/load history with `_meta.isReplay`. Replay must never
    // drive the turn machine; the UI treats channel=replay as backfill only.
    let replay = acp_msg::is_replay_tagged(&msg);
    match acp_msg::classify(&msg) {
        Incoming::SessionUpdate {
            session_id,
            update,
            eid,
        } => {
            if session_id.is_empty() {
                return;
            }
            if let Some(mode_id) = update.mode_change().filter(|_| !replay) {
                if let Some(mode) = overlay::adopt_agent_mode(&session_id, mode_id) {
                    let _ = app.emit(
                        "acp://mode",
                        json!({ "sessionId": session_id, "mode": mode }),
                    );
                }
            }
            let _ = app.emit(
                "acp://stream",
                acp_msg::AcpStreamEvent {
                    session_id,
                    update,
                    channel: Some(if replay { "replay" } else { "live" }),
                    eid,
                },
            );
        }
        Incoming::PromptStopped { id, stop_reason } => {
            let Some(session_id) = settle_prompt(app, &id) else {
                return;
            };
            let _ = app.emit(
                "acp://stream",
                acp_msg::AcpStreamEvent {
                    session_id,
                    update: acp_msg::SessionUpdate::turn_completed(&stop_reason),
                    channel: Some("live"),
                    eid: None,
                },
            );
        }
        Incoming::ClientRequest { id, method, params } => {
            let mut options = acp_msg::extract_options(&params);
            let mut questions = acp_msg::extract_questions(&params, &options);
            if acp_msg::is_folder_trust_method(&method) && questions.is_empty() {
                questions = acp_msg::folder_trust_questions(&params);
                options = questions
                    .first()
                    .map(|row| row.options.clone())
                    .unwrap_or_default();
            } else if acp_msg::is_exit_plan_method(&method) && questions.is_empty() {
                questions = acp_msg::plan_approval_questions();
                options = questions
                    .first()
                    .map(|row| row.options.clone())
                    .unwrap_or_default();
            }
            if acp_msg::is_hitl_request(&method, &options, &questions) {
                let session_id = params
                    .get("sessionId")
                    .and_then(|s| s.as_str())
                    .unwrap_or_default()
                    .to_string();
                let ev = AgentRequestEvent {
                    request_id: id,
                    session_id,
                    method,
                    params,
                    options,
                    questions,
                };
                let _ = app.emit("acp://agent-request", ev);
            } else if let Some(state) = app.try_state::<Mutex<AppState>>() {
                if let Ok(guard) = state.lock() {
                    let _ = guard.link.respond_error(
                        id,
                        -32601,
                        &format!("Method not found: {method}"),
                    );
                }
            }
        }
        Incoming::ExtNotification { method, params } => {
            if acp_msg::is_queue_changed_method(&method) {
                let _ = app.emit("acp://queue", params);
                return;
            }
            if acp_msg::is_sessions_changed_method(&method) {
                let _ = app.emit("acp://roster-changed", params);
                return;
            }
            if let Some((session_id, tool_call_id)) =
                acp_msg::resolved_interaction(&method, &params)
            {
                let _ = app.emit(
                    "acp://interaction-resolved",
                    json!({ "sessionId": session_id, "toolCallId": tool_call_id }),
                );
            }
        }
        Incoming::RpcError {
            id,
            code,
            message,
            data,
        } => {
            let Some(session_id) = settle_prompt(app, &id) else {
                return;
            };
            eprintln!("[ava] session/prompt error code={code} message={message}");
            let _ = app.emit(
                "acp://prompt-error",
                json!({
                    "sessionId": session_id,
                    "code": code,
                    "message": message,
                    "data": data,
                }),
            );
        }
        Incoming::Ignore => {}
    }
}

/// A bare `stopReason` or error names no session, so the in-flight prompt id is
/// the only way home. An id nobody is waiting on is a leftover from an earlier
/// turn and must not unlock a composer.
fn settle_prompt(app: &AppHandle, rpc_id: &Value) -> Option<String> {
    let state = app.try_state::<Mutex<AppState>>()?;
    let mut guard = state.lock().ok()?;
    let session_id = guard.link.session_for_prompt_rpc(rpc_id)?;
    guard.link.settle_rpc(&session_id, rpc_id);
    Some(session_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn logout_close_accepts_only_authoritative_terminal_outcomes() {
        assert!(
            validate_logout_close("closed", &json!({ "success": true, "outcome": "closed" }))
                .is_ok()
        );
        assert!(validate_logout_close(
            "missing",
            &json!({ "success": true, "outcome": "notResident" })
        )
        .is_ok());
        assert!(validate_logout_close(
            "replaced",
            &json!({ "success": true, "outcome": "superseded" })
        )
        .unwrap_err()
        .contains("replaced"));
        assert!(
            validate_logout_close("bad", &json!({ "success": false, "outcome": "closed" }))
                .is_err()
        );
    }

    #[test]
    fn post_commit_failure_keeps_the_committed_value() {
        let (session_id, followed_up) = keep_remote_commit(
            "created-session".to_string(),
            "test follow-up",
            Err("overlay unavailable".into()),
        );
        assert_eq!(session_id, "created-session");
        assert!(!followed_up);
    }

    #[test]
    fn roster_cwd_uses_the_exact_authoritative_session() {
        let roster = json!({
            "sessions": [
                { "sessionId": "session-1", "cwd": "/repo/one " },
                { "sessionId": "session-10", "cwd": "/repo/ten" }
            ]
        });
        assert_eq!(
            session_cwd_from_roster(&roster, "session-1").unwrap(),
            "/repo/one "
        );
    }

    #[test]
    fn roster_cwd_fails_clearly_when_session_or_cwd_is_missing() {
        let roster = json!({
            "sessions": [{ "sessionId": "without-cwd", "cwd": "" }]
        });
        assert!(session_cwd_from_roster(&roster, "missing")
            .unwrap_err()
            .contains("not found"));
        assert!(session_cwd_from_roster(&roster, "without-cwd")
            .unwrap_err()
            .contains("has no cwd"));
        assert!(session_cwd_from_roster(&json!({}), "missing")
            .unwrap_err()
            .contains("sessions must be an array"));
    }
}
