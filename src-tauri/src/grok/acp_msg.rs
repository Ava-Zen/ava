use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::grok::types::{AgentQuestion, AgentRequestOption};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpStreamEvent {
    pub session_id: String,
    pub update: SessionUpdate,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel: Option<&'static str>,
    /// Grok's `params._meta.eventId`. Lifted out of the notification meta
    /// because only `params.update` is forwarded to the webview.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub eid: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionUpdate {
    #[serde(default)]
    pub session_update: Option<String>,
    #[serde(default)]
    pub content: Option<Value>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub raw_input: Option<Value>,
    #[serde(default)]
    pub stop_reason: Option<String>,
    #[serde(default)]
    pub tool_call_id: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    /// `current_mode_update`: the agent switched session mode on its own
    /// (plan approval, mid-turn plan activation).
    #[serde(default)]
    pub current_mode_id: Option<String>,
    /// `available_commands_update`: the agent's own slash catalog.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub available_commands: Option<Value>,
    #[serde(default, rename = "_meta")]
    pub meta: Option<Value>,
}

impl SessionUpdate {
    pub fn turn_completed(stop_reason: &str) -> Self {
        Self {
            session_update: Some("turn_completed".into()),
            stop_reason: Some(stop_reason.into()),
            ..Self::default()
        }
    }

    pub fn kind(&self) -> &str {
        self.session_update.as_deref().unwrap_or("")
    }

    /// The mode id when this update is a `current_mode_update`.
    pub fn mode_change(&self) -> Option<&str> {
        if self.kind() != "current_mode_update" {
            return None;
        }
        self.current_mode_id.as_deref().filter(|id| !id.is_empty())
    }
}

#[derive(Debug, Deserialize)]
struct RpcMessage {
    #[serde(default)]
    id: Option<Value>,
    #[serde(default)]
    method: Option<String>,
    #[serde(default)]
    params: Option<Value>,
    #[serde(default)]
    result: Option<Value>,
    #[serde(default)]
    error: Option<Value>,
}

#[derive(Debug, Default, Deserialize)]
struct RpcErrorObject {
    #[serde(default)]
    code: i64,
    #[serde(default)]
    message: String,
    #[serde(default)]
    data: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[derive(Default)]
struct SessionUpdateParams {
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    update: SessionUpdate,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PromptResult {
    #[serde(default)]
    stop_reason: Option<String>,
}

#[derive(Debug)]
pub enum Incoming {
    SessionUpdate {
        session_id: String,
        update: SessionUpdate,
        eid: Option<String>,
    },
    PromptStopped {
        /// JSON-RPC id of the `session/prompt` this result answers. Matched
        /// against the session's in-flight ids so a stale result cannot end a
        /// live turn.
        id: Value,
        stop_reason: String,
    },
    ClientRequest {
        id: Value,
        method: String,
        params: Value,
    },
    /// Agent → client notification that is not `session/update`.
    /// Grok's TUI drives the follow-up list from `x.ai/queue/changed`.
    ExtNotification {
        method: String,
        params: Value,
    },
    RpcError {
        id: Value,
        code: i64,
        message: String,
        data: Option<Value>,
    },
    Ignore,
}

pub fn classify(msg: &Value) -> Incoming {
    let parsed: RpcMessage = match serde_json::from_value(msg.clone()) {
        Ok(row) => row,
        Err(_) => return Incoming::Ignore,
    };
    if let Some(err) = parsed.error.as_ref() {
        let body = serde_json::from_value::<RpcErrorObject>(err.clone()).unwrap_or_default();
        return Incoming::RpcError {
            id: parsed.id.clone().unwrap_or(Value::Null),
            code: body.code,
            message: body.message,
            data: body.data,
        };
    }
    let (method, params) = canonical_envelope(&parsed);
    if is_session_update_method(&method) {
        let update_params =
            serde_json::from_value::<SessionUpdateParams>(params).unwrap_or_default();
        let session_id = update_params
            .session_id
            .filter(|id| !id.is_empty())
            .unwrap_or_default();
        return Incoming::SessionUpdate {
            session_id,
            eid: event_id(msg),
            update: update_params.update,
        };
    }
    if let Some(stop) = parsed
        .result
        .as_ref()
        .and_then(|row| serde_json::from_value::<PromptResult>(row.clone()).ok())
        .and_then(|row| row.stop_reason)
    {
        return Incoming::PromptStopped {
            id: parsed.id.unwrap_or(Value::Null),
            stop_reason: stop,
        };
    }
    if parsed.method.is_some() && parsed.id.is_some() && parsed.result.is_none() {
        return Incoming::ClientRequest {
            id: parsed.id.unwrap_or(Value::Null),
            method,
            params,
        };
    }
    if !method.is_empty() && parsed.id.is_none() && parsed.result.is_none() {
        return Incoming::ExtNotification { method, params };
    }
    Incoming::Ignore
}

/// Normalize Grok's current extension envelope once at the ACP boundary.
/// Standard ACP messages are already flat. Extension messages use a leading
/// underscore and may wrap the public method and params one level deeper.
fn canonical_envelope(message: &RpcMessage) -> (String, Value) {
    let top = message.method.as_deref().unwrap_or("");
    let mut method = top.strip_prefix('_').unwrap_or(top).to_string();
    let mut params = message.params.clone().unwrap_or(Value::Null);
    if top.starts_with('_') {
        if let Some(inner_method) = params.get("method").and_then(Value::as_str) {
            method = inner_method.to_string();
        }
        if let Some(inner_params) = params.get("params") {
            params = inner_params.clone();
        }
    }
    (method, params)
}

pub fn is_session_update_method(method: &str) -> bool {
    matches!(method, "session/update" | "x.ai/session/update")
}

pub fn is_exit_plan_method(method: &str) -> bool {
    method == "x.ai/exit_plan_mode"
}

/// A shared modal is first-answer-wins: whoever answers it, every client on the
/// leader is told to take its own card down. The notice arrives on Grok's
/// `session_notification` channel naming the tool call in snake_case, while the
/// reverse-request that opened the card used camelCase.
///
/// One tool call resolves twice — the permission phase closes before the
/// question phase opens, under the same id — so this only identifies the notice.
/// Acting on an id no card is showing is what keeps the first resolution from
/// dismissing the question that is about to arrive.
pub fn resolved_interaction(method: &str, params: &Value) -> Option<(String, String)> {
    if method != "x.ai/session_notification" {
        return None;
    }
    let update = params.get("update")?;
    if update.get("sessionUpdate")?.as_str()? != "interaction_resolved" {
        return None;
    }
    let tool_call_id = update
        .get("tool_call_id")?
        .as_str()
        .filter(|id| !id.is_empty())?
        .to_string();
    let session_id = params
        .get("sessionId")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    Some((session_id, tool_call_id))
}

pub fn is_hitl_request(
    method: &str,
    options: &[AgentRequestOption],
    questions: &[AgentQuestion],
) -> bool {
    !options.is_empty()
        || !questions.is_empty()
        || method == "session/request_permission"
        || is_folder_trust_method(method)
        || method == "x.ai/ask_user_question"
        || method == "x.ai/exit_plan_mode"
}

pub fn is_folder_trust_method(method: &str) -> bool {
    method == "x.ai/folder_trust/request"
}

pub fn folder_trust_questions(params: &Value) -> Vec<AgentQuestion> {
    let workspace = params
        .get("workspace")
        .and_then(Value::as_str)
        .unwrap_or("this workspace");
    let kinds = params
        .get("configKinds")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(", ")
        })
        .filter(|kinds| !kinds.is_empty());
    vec![AgentQuestion {
        question: format!("Trust {workspace}?"),
        header: kinds.map(|kinds| format!("Allow project {kinds} configuration")),
        multi_select: false,
        options: vec![
            AgentRequestOption {
                option_id: "trust".into(),
                name: "Trust".into(),
                description: Some("Allow Grok to load this workspace configuration".into()),
            },
            AgentRequestOption {
                option_id: "reject".into(),
                name: "Not now".into(),
                description: Some("Keep project configuration disabled".into()),
            },
        ],
    }]
}

pub fn plan_approval_questions() -> Vec<AgentQuestion> {
    vec![AgentQuestion {
        question: "Approve this plan?".into(),
        header: Some("The agent finished planning.".into()),
        multi_select: false,
        options: vec![
            AgentRequestOption {
                option_id: "approved".into(),
                name: "Approve".into(),
                description: Some("Leave plan mode and start implementing".into()),
            },
            AgentRequestOption {
                option_id: "cancelled".into(),
                name: "Request changes".into(),
                description: Some("Send the agent back to planning".into()),
            },
            AgentRequestOption {
                option_id: "abandoned".into(),
                name: "Quit".into(),
                description: Some("Abandon the plan and turn plan mode off".into()),
            },
        ],
    }]
}

pub fn extract_options(params: &Value) -> Vec<AgentRequestOption> {
    let pointers = ["/options", "/questions/0/options"];
    for pointer in pointers {
        if let Some(arr) = params.pointer(pointer).and_then(|v| v.as_array()) {
            let out = parse_options(arr);
            if !out.is_empty() {
                return out;
            }
        }
    }
    Vec::new()
}

pub fn extract_questions(params: &Value, fallback: &[AgentRequestOption]) -> Vec<AgentQuestion> {
    if let Some(arr) = params.pointer("/questions").and_then(|v| v.as_array()) {
        let out: Vec<AgentQuestion> = arr.iter().filter_map(parse_question).collect();
        if !out.is_empty() {
            return out;
        }
    }
    if fallback.is_empty() {
        return Vec::new();
    }
    let title = params
        .pointer("/toolCall/title")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    vec![AgentQuestion {
        question: title,
        header: None,
        multi_select: false,
        options: fallback.to_vec(),
    }]
}

fn parse_question(row: &Value) -> Option<AgentQuestion> {
    let question = row.get("question")?.as_str()?.to_string();
    let options = row
        .get("options")
        .and_then(|v| v.as_array())
        .map(|arr| parse_options(arr))
        .unwrap_or_default();
    Some(AgentQuestion {
        question,
        header: None,
        multi_select: row
            .get("multiSelect")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        options,
    })
}

fn parse_options(arr: &[Value]) -> Vec<AgentRequestOption> {
    arr.iter()
        .filter_map(|o| {
            let name = o
                .get("name")
                .or_else(|| o.get("label"))
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())?
                .to_string();
            let option_id = o
                .get("optionId")
                .or_else(|| o.get("id"))
                .and_then(|v| v.as_str())
                .unwrap_or(name.as_str())
                .to_string();
            Some(AgentRequestOption {
                option_id,
                name,
                description: o
                    .get("description")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
            })
        })
        .collect()
}

pub fn session_prompt_params(session_id: &str, text: &str, meta: Value) -> Value {
    json!({
        "sessionId": session_id,
        "prompt": [{ "type": "text", "text": text }],
        "_meta": meta
    })
}

/// Stable product identity used by initialize and session new/load metadata.
pub const CLIENT_ID: &str = "ava";

/// Stamp `clientIdentifier` so Grok can tell Korg's sessions from the TUI's.
pub fn stamp_client_id(mut meta: Value) -> Value {
    if let Some(map) = meta.as_object_mut() {
        map.insert("clientIdentifier".into(), json!(CLIENT_ID));
    }
    meta
}

/// `session/load` params. `_meta.noReplay: true` tells Grok to skip the wire
/// replay entirely — Korg hydrates the transcript from disk and never wants
/// the dump.
pub fn session_load_params(session_id: &str, cwd: &str, mut permission_meta: Value) -> Value {
    if let Some(map) = permission_meta.as_object_mut() {
        map.insert("noReplay".into(), json!(true));
    }
    json!({
        "sessionId": session_id,
        "cwd": cwd,
        "mcpServers": [],
        "_meta": stamp_client_id(permission_meta)
    })
}

/// ACP `session/set_mode`. Idempotent, unlike `x.ai/toggle_plan_mode`.
pub fn session_set_mode_params(session_id: &str, mode_id: &str) -> Value {
    json!({
        "sessionId": session_id,
        "modeId": mode_id
    })
}

/// Grok stamps `_meta.isReplay: true` on every notification it replays for
/// `session/load`. Deterministic replay signal — no content sniffing needed.
/// `params._meta.eventId` — Grok's opaque per-session identity, also
/// written into `updates.jsonl`, so disk hydrate and the live stream name the
/// same event with the same string.
pub fn event_id(msg: &Value) -> Option<String> {
    current_params(msg)
        .pointer("/_meta/eventId")?
        .as_str()
        .map(str::to_string)
}

pub fn is_replay_tagged(msg: &Value) -> bool {
    current_params(msg)
        .pointer("/_meta/isReplay")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

fn current_params(msg: &Value) -> &Value {
    let params = &msg["params"];
    params.get("params").unwrap_or(params)
}

/// TUI stamps `_meta.promptId` so `x.ai/queue/changed` can correlate the row,
/// and `_meta.sendNow` for cancel-and-send. Merge onto permission meta.
pub fn stamp_prompt_meta(mut meta: Value, prompt_id: Option<&str>, send_now: bool) -> Value {
    if !meta.is_object() {
        meta = json!({});
    }
    let map = meta.as_object_mut().expect("object created above");
    if let Some(id) = prompt_id.map(str::trim).filter(|id| !id.is_empty()) {
        map.insert("promptId".into(), json!(id));
    }
    if send_now {
        map.insert("sendNow".into(), json!(true));
    }
    map.insert("clientIdentifier".into(), json!(owner()));
    meta
}

/// Queue rows outlive an individual Korg proxy in Grok's shared leader. Use the
/// stable product identity so a restarted app can still clear/edit prompts it
/// queued earlier. Prompt `clientIdentifier` and queue `owner` must match.
pub fn owner() -> &'static str {
    CLIENT_ID
}

/// Queue mutations require the same owner that Grok recorded on the prompt.
/// It is a top-level extension param, not notification metadata.
pub fn stamp_queue_owner(mut params: Value) -> Value {
    if !params.is_object() {
        params = json!({});
    }
    params
        .as_object_mut()
        .expect("object created above")
        .insert("owner".into(), json!(owner()));
    params
}

pub fn session_delete_params(session_id: &str, cwd: Option<&str>) -> Value {
    let mut params = json!({ "sessionId": session_id });
    if let Some(cwd) = cwd.filter(|row| !row.trim().is_empty()) {
        params["cwd"] = json!(cwd);
    }
    params
}

pub fn session_fork_params(source_session_id: &str, source_cwd: &str, new_cwd: &str) -> Value {
    json!({
        "sourceSessionId": source_session_id,
        "sourceCwd": source_cwd,
        "newCwd": new_cwd,
    })
}

pub fn is_queue_changed_method(method: &str) -> bool {
    method == "x.ai/queue/changed"
}

pub fn is_sessions_changed_method(method: &str) -> bool {
    method == "x.ai/sessions/changed"
}

pub fn is_queue_control_method(method: &str) -> bool {
    matches!(
        method,
        "x.ai/queue/edit"
            | "x.ai/queue/remove"
            | "x.ai/queue/interject"
            | "x.ai/queue/hold_edit"
            | "x.ai/queue/release_edit"
            | "x.ai/queue/reorder"
            | "x.ai/queue/clear"
    )
}

/// ACP `session/cancel` is `{ sessionId, _meta? }`.
/// Grok reads `cancelTrigger` / `cancelSubagents` from `_meta` (TUI Esc / Stop).
pub fn session_cancel_params(session_id: &str, cancel_trigger: Option<&str>) -> Value {
    let trigger = cancel_trigger
        .map(str::trim)
        .filter(|row| !row.is_empty())
        .unwrap_or("mouse");
    json!({
        "sessionId": session_id,
        "_meta": {
            "cancelTrigger": trigger,
            "cancelSubagents": true,
        }
    })
}

pub fn jsonrpc_notification(method: &str, params: Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "method": method,
        "params": params
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn classifies_session_update_and_prompt_stop() {
        let update = json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": "abc",
                "_meta": { "eventId": "abc-9" },
                "update": { "sessionUpdate": "agent_thought_chunk" }
            }
        });
        match classify(&update) {
            Incoming::SessionUpdate {
                session_id,
                update,
                eid,
            } => {
                assert_eq!(session_id, "abc");
                assert_eq!(update.kind(), "agent_thought_chunk");
                assert_eq!(eid.as_deref(), Some("abc-9"));
            }
            other => panic!("expected session update, got {other:?}"),
        }

        let stop = json!({
            "jsonrpc": "2.0",
            "id": 3,
            "result": { "stopReason": "end_turn" }
        });
        match classify(&stop) {
            Incoming::PromptStopped { id, stop_reason } => {
                assert_eq!(id, json!(3));
                assert_eq!(stop_reason, "end_turn");
            }
            other => panic!("expected stop, got {other:?}"),
        }
    }

    #[test]
    fn classifies_jsonrpc_error_before_method() {
        let err = json!({
            "jsonrpc": "2.0",
            "id": 7,
            "error": { "code": 429, "message": "out of usage" }
        });
        match classify(&err) {
            Incoming::RpcError {
                id,
                code,
                message,
                data,
            } => {
                assert_eq!(id, json!(7));
                assert_eq!(code, 429);
                assert_eq!(message, "out of usage");
                assert!(data.is_none());
            }
            other => panic!("expected rpc error, got {other:?}"),
        }

        let with_method = json!({
            "jsonrpc": "2.0",
            "id": 7,
            "method": "session/prompt",
            "error": {
                "code": 429,
                "message": "out of usage",
                "data": { "retryAfter": 60 }
            }
        });
        match classify(&with_method) {
            Incoming::RpcError {
                id,
                code,
                message,
                data,
            } => {
                assert_eq!(id, json!(7));
                assert_eq!(code, 429);
                assert_eq!(message, "out of usage");
                assert_eq!(data, Some(json!({ "retryAfter": 60 })));
            }
            other => panic!("expected rpc error despite method, got {other:?}"),
        }

        let no_id = json!({
            "jsonrpc": "2.0",
            "error": { "code": 429, "message": "out of usage" }
        });
        match classify(&no_id) {
            Incoming::RpcError {
                id, code, message, ..
            } => {
                assert!(id.is_null());
                assert_eq!(code, 429);
                assert_eq!(message, "out of usage");
            }
            other => panic!("expected rpc error, got {other:?}"),
        }

        assert!(!is_replay_tagged(&err));
    }

    #[test]
    fn classifies_hitl_request() {
        let msg = json!({
            "jsonrpc": "2.0",
            "id": 9,
            "method": "session/request_permission",
            "params": {
                "sessionId": "s",
                "options": [{ "optionId": "allow", "name": "Allow" }]
            }
        });
        match classify(&msg) {
            Incoming::ClientRequest { method, params, .. } => {
                let options = extract_options(&params);
                assert!(is_hitl_request(&method, &options, &[]));
                assert_eq!(options[0].option_id, "allow");
            }
            other => panic!("expected request, got {other:?}"),
        }
    }

    #[test]
    fn unwraps_the_current_grok_extension_envelope() {
        let msg = json!({
            "jsonrpc": "2.0",
            "id": 10,
            "method": "_x.ai/ask_user_question",
            "params": {
                "method": "x.ai/ask_user_question",
                "params": {
                    "sessionId": "s",
                    "toolCallId": "call-1",
                    "questions": [{
                        "question": "Ship it?",
                        "options": [{ "label": "Ship", "description": "Deploy now" }],
                        "multiSelect": false
                    }]
                }
            }
        });
        match classify(&msg) {
            Incoming::ClientRequest { method, params, .. } => {
                assert_eq!(method, "x.ai/ask_user_question");
                assert_eq!(params["sessionId"], "s");
                let questions = extract_questions(&params, &[]);
                assert_eq!(questions[0].question, "Ship it?");
                assert_eq!(questions[0].options[0].name, "Ship");
            }
            other => panic!("expected wrapped request, got {other:?}"),
        }
    }

    #[test]
    fn treats_exit_plan_ext_method_as_hitl() {
        assert!(is_exit_plan_method("x.ai/exit_plan_mode"));
        assert!(is_hitl_request("x.ai/exit_plan_mode", &[], &[]));
        let questions = plan_approval_questions();
        assert_eq!(questions[0].options[0].option_id, "approved");
        assert_eq!(questions[0].options[1].option_id, "cancelled");
        assert_eq!(questions[0].options[2].option_id, "abandoned");
    }

    #[test]
    fn folder_trust_uses_the_current_acp_request() {
        let params = json!({
            "workspace": "/repo",
            "configKinds": ["hooks", "mcp"]
        });
        assert!(is_hitl_request("x.ai/folder_trust/request", &[], &[]));
        let questions = folder_trust_questions(&params);
        assert_eq!(questions.len(), 1);
        assert_eq!(questions[0].question, "Trust /repo?");
        assert_eq!(
            questions[0].header.as_deref(),
            Some("Allow project hooks, mcp configuration")
        );
        assert_eq!(questions[0].options[0].option_id, "trust");
        assert_eq!(questions[0].options[1].option_id, "reject");
    }

    #[test]
    fn prompt_params_carry_permission_meta() {
        let params =
            session_prompt_params("s", "hello", json!({ "yoloMode": false, "autoMode": true }));
        assert_eq!(params["sessionId"], "s");
        assert_eq!(params["prompt"][0]["text"], "hello");
        assert_eq!(params["_meta"]["autoMode"], true);
        assert_eq!(params["_meta"]["yoloMode"], false);
    }

    #[test]
    fn stamp_prompt_meta_matches_tui_wire() {
        let meta = stamp_prompt_meta(
            json!({ "yoloMode": false, "autoMode": true }),
            Some("follow_abc"),
            true,
        );
        assert_eq!(meta["promptId"], "follow_abc");
        assert_eq!(meta["sendNow"], true);
        assert_eq!(meta["autoMode"], true);
        assert_eq!(meta["clientIdentifier"], owner());
        assert!(meta.get("owner").is_none());
        let queued = stamp_prompt_meta(json!({}), Some("  "), false);
        assert!(queued.get("promptId").is_none());
        assert!(queued.get("sendNow").is_none());
    }

    #[test]
    fn event_id_accepts_the_current_string_wire_shape() {
        let string = json!({ "params": { "_meta": { "eventId": "session-a-42" } } });
        assert_eq!(event_id(&string).as_deref(), Some("session-a-42"));

        let wire = AcpStreamEvent {
            session_id: "s".into(),
            update: SessionUpdate::default(),
            channel: Some("live"),
            eid: event_id(&string),
        };
        assert_eq!(
            serde_json::to_value(wire).unwrap()["eid"],
            json!("session-a-42")
        );
    }

    #[test]
    fn queue_owner_is_restart_stable_and_matches_prompt_meta() {
        let prompt = stamp_prompt_meta(json!({}), None, false);
        let clear = stamp_queue_owner(json!({ "sessionId": "s" }));
        let remove = stamp_queue_owner(json!({ "sessionId": "s", "promptId": "p" }));
        assert_eq!(clear["owner"], prompt["clientIdentifier"]);
        assert_eq!(clear["owner"], CLIENT_ID);
        assert_eq!(remove["owner"], CLIENT_ID);
        assert_eq!(owner(), CLIENT_ID);
        assert_eq!(owner(), owner());
        assert!(clear.get("_meta").is_none());
        assert!(remove.get("_meta").is_none());
    }

    #[test]
    fn native_session_mutation_params_match_grok_extensions() {
        let delete = session_delete_params("source", Some("/work"));
        assert_eq!(delete, json!({ "sessionId": "source", "cwd": "/work" }));
        let fork = session_fork_params("source", "/work", "/copy");
        assert_eq!(
            fork,
            json!({
                "sourceSessionId": "source",
                "sourceCwd": "/work",
                "newCwd": "/copy"
            })
        );
    }

    #[test]
    fn classifies_queue_changed_notification() {
        // Grok emits the underscore form; matching the bare name only would
        // silently drop every queue update.
        let msg = json!({
            "jsonrpc": "2.0",
            "method": "_x.ai/queue/changed",
            "params": {
                "sessionId": "s1",
                "entries": [{ "id": "p1", "text": "hello", "version": 0, "position": 0 }],
                "runningPromptId": "p0"
            }
        });
        match classify(&msg) {
            Incoming::ExtNotification { method, params } => {
                assert!(is_queue_changed_method(&method));
                assert_eq!(params["sessionId"], "s1");
                assert_eq!(params["entries"][0]["id"], "p1");
            }
            other => panic!("expected queue notification, got {other:?}"),
        }
        assert!(is_queue_changed_method("x.ai/queue/changed"));
        assert!(is_sessions_changed_method("x.ai/sessions/changed"));
        assert!(is_queue_control_method("x.ai/queue/edit"));
        assert!(is_queue_control_method("x.ai/queue/interject"));
        assert!(!is_queue_control_method("x.ai/queue/changed"));
    }

    #[test]
    fn reads_a_shared_modal_resolution_off_the_notification_channel() {
        // Snake_case here, camelCase on the reverse-request that opened the card.
        let notice = json!({
            "sessionId": "s1",
            "update": { "sessionUpdate": "interaction_resolved", "tool_call_id": "call-a-0" }
        });
        assert_eq!(
            resolved_interaction("x.ai/session_notification", &notice),
            Some(("s1".into(), "call-a-0".into()))
        );

        // The pending half of the pair opens a card; it must not close one.
        let pending = json!({
            "sessionId": "s1",
            "update": {
                "sessionUpdate": "pending_interaction",
                "kind": "question",
                "tool_call_id": "call-a-0"
            }
        });
        assert_eq!(
            resolved_interaction("x.ai/session_notification", &pending),
            None
        );
        // A resolution carries no kind, so the channel and id are all we get.
        assert_eq!(resolved_interaction("x.ai/queue/changed", &notice), None);
        assert_eq!(
            resolved_interaction(
                "x.ai/session_notification",
                &json!({ "update": { "sessionUpdate": "interaction_resolved" } })
            ),
            None
        );
    }

    #[test]
    fn session_cancel_wire_form_is_a_notification() {
        let msg = jsonrpc_notification("session/cancel", session_cancel_params("abc", Some("esc")));
        assert_eq!(msg["jsonrpc"], "2.0");
        assert_eq!(msg["method"], "session/cancel");
        assert_eq!(msg["params"]["sessionId"], "abc");
        assert!(msg["params"].get("cancelSubagents").is_none());
        assert_eq!(msg["params"]["_meta"]["cancelTrigger"], "esc");
        assert_eq!(msg["params"]["_meta"]["cancelSubagents"], true);
        assert!(msg.get("id").is_none());
        let mouse = session_cancel_params("abc", None);
        assert_eq!(mouse["_meta"]["cancelTrigger"], "mouse");
    }

    #[test]
    fn set_mode_params_are_explicit() {
        let params = session_set_mode_params("abc", "plan");
        assert_eq!(params["sessionId"], "abc");
        assert_eq!(params["modeId"], "plan");
    }

    #[test]
    fn current_mode_update_exposes_mode_id() {
        let msg = json!({
            "method": "session/update",
            "params": {
                "sessionId": "s",
                "update": { "sessionUpdate": "current_mode_update", "currentModeId": "plan" }
            }
        });
        match classify(&msg) {
            Incoming::SessionUpdate { update, .. } => {
                assert_eq!(update.mode_change(), Some("plan"));
            }
            other => panic!("expected session update, got {other:?}"),
        }
        let chunk = SessionUpdate {
            session_update: Some("agent_message_chunk".into()),
            current_mode_id: Some("plan".into()),
            ..SessionUpdate::default()
        };
        assert_eq!(chunk.mode_change(), None);
    }

    #[test]
    fn load_params_request_no_replay() {
        let params =
            session_load_params("s", "/repo", json!({ "yoloMode": false, "autoMode": true }));
        assert_eq!(params["sessionId"], "s");
        assert_eq!(params["cwd"], "/repo");
        assert_eq!(params["_meta"]["noReplay"], true);
        assert_eq!(params["_meta"]["autoMode"], true);
        assert_eq!(params["_meta"]["yoloMode"], false);
        assert_eq!(params["_meta"]["clientIdentifier"], CLIENT_ID);
        assert!(params["mcpServers"].as_array().unwrap().is_empty());
    }

    #[test]
    fn replay_tag_is_deterministic() {
        let tagged = json!({
            "method": "session/update",
            "params": {
                "sessionId": "s",
                "_meta": { "isReplay": true },
                "update": { "sessionUpdate": "agent_message_chunk" }
            }
        });
        assert!(is_replay_tagged(&tagged));
        let live = json!({
            "method": "session/update",
            "params": {
                "sessionId": "s",
                "update": { "sessionUpdate": "agent_message_chunk" }
            }
        });
        assert!(!is_replay_tagged(&live));
        assert!(!is_replay_tagged(&json!({
            "method": "session/update",
            "params": { "_meta": { "isReplay": false }, "update": {} }
        })));
    }
}
