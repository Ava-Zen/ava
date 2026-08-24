use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RosterItem {
    pub session_id: String,
    pub cwd: String,
    pub title: String,
    pub preview: String,
    pub color: String,
    pub shape: String,
    pub pinned: bool,
    pub updated_at: String,
    pub model_id: Option<String>,
    #[serde(default)]
    pub unread: bool,
    #[serde(default)]
    pub effort: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RosterSnapshot {
    pub rows: Vec<RosterItem>,
    pub live_ids: Vec<String>,
    pub running_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentInfo {
    pub session_id: String,
    pub parent_session_id: String,
    pub subagent_type: String,
    pub description: String,
    pub status: String,
    pub model_id: Option<String>,
    pub duration_ms: Option<u64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptItem {
    pub kind: String,
    pub text: String,
    pub title: Option<String>,
    pub meta: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub details: Option<Vec<String>>,
    #[serde(default)]
    pub images: Option<Vec<String>>,
    #[serde(default)]
    pub at: Option<String>,
    /// Opaque `_meta.eventId` of the journal line this item came from. Preserve
    /// the complete value so live delivery and journal replay can compare it.
    #[serde(default)]
    pub eid: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayPage {
    pub items: Vec<TranscriptItem>,
    pub has_more: bool,
    pub cursor: u64,
    #[serde(default)]
    pub turn_complete: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCaps {
    pub initialize: serde_json::Value,
    pub live_acp_allowed: bool,
    pub blocked_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    pub signed_in: bool,
    pub message: String,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrokInfo {
    pub path: String,
    pub version: String,
    pub grok_home: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrokUpdateCheck {
    pub current_version: String,
    pub latest_version: String,
    pub update_available: bool,
    #[serde(default)]
    pub channel: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRequestEvent {
    pub request_id: serde_json::Value,
    pub session_id: String,
    pub method: String,
    pub params: serde_json::Value,
    pub options: Vec<AgentRequestOption>,
    #[serde(default)]
    pub questions: Vec<AgentQuestion>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentQuestion {
    pub question: String,
    pub header: Option<String>,
    #[serde(default)]
    pub multi_select: bool,
    pub options: Vec<AgentRequestOption>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRequestOption {
    pub option_id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub kind: String,
    pub preview: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummary {
    pub plan: String,
    pub percent: Option<u64>,
    pub resets_at: Option<String>,
    pub manage_url: String,
    pub cycle: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDetail {
    pub session_id: String,
    pub title: String,
    pub cwd: String,
    pub model_id: String,
    pub effort: String,
    pub agent_name: String,
    pub created_at: String,
    pub updated_at: String,
    pub turn_count: u64,
    pub user_messages: u64,
    pub tool_calls: u64,
    pub compaction_count: u64,
    pub context_used: u64,
    pub context_window: u64,
    pub context_percent: u64,
}
