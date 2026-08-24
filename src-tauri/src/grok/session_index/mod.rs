use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

use serde::Deserialize;

use crate::grok::grok_bin::grok_home;
use crate::grok::types::{SessionDetail, SubagentInfo};

mod replay;
pub use replay::replay_page;

struct DirIndex {
    home: PathBuf,
    by_id: HashMap<String, PathBuf>,
}

static DIR_INDEX: LazyLock<Mutex<DirIndex>> = LazyLock::new(|| {
    Mutex::new(DirIndex {
        home: PathBuf::new(),
        by_id: HashMap::new(),
    })
});

#[derive(Debug, Deserialize)]
struct SummaryFile {
    info: Option<SummaryInfo>,
    session_summary: Option<String>,
    generated_title: Option<String>,
    last_turn_summary: Option<String>,
    created_at: Option<String>,
    updated_at: Option<String>,
    last_active_at: Option<String>,
    current_model_id: Option<String>,
    agent_name: Option<String>,
    reasoning_effort: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SummaryInfo {
    id: Option<String>,
    cwd: Option<String>,
}

fn remember_dir(home: &Path, session_id: &str, dir: PathBuf) {
    let Ok(mut index) = DIR_INDEX.lock() else {
        return;
    };
    if index.home != home {
        index.home = home.to_path_buf();
        index.by_id.clear();
    }
    index.by_id.insert(session_id.to_string(), dir);
}

fn cached_dir(home: &Path, session_id: &str) -> Option<PathBuf> {
    let index = DIR_INDEX.lock().ok()?;
    (index.home == home)
        .then(|| index.by_id.get(session_id).cloned())
        .flatten()
}

pub fn find_dir(session_id: &str) -> Result<PathBuf, String> {
    find_dir_under(&grok_home(), session_id)
}

pub(crate) fn find_dir_under(home: &Path, session_id: &str) -> Result<PathBuf, String> {
    if let Some(dir) = cached_dir(home, session_id) {
        if dir.join("summary.json").is_file() {
            return Ok(dir);
        }
    }
    let root = home.join("sessions");
    let dir = find_session_dir(&root, session_id)
        .ok_or_else(|| format!("session {session_id} not found"))?;
    remember_dir(home, session_id, dir.clone());
    Ok(dir)
}

fn find_session_dir(root: &Path, session_id: &str) -> Option<PathBuf> {
    for entry in fs::read_dir(root).ok()?.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let summary = path.join("summary.json");
        if summary.is_file() {
            let folder_matches =
                path.file_name().and_then(|name| name.to_str()) == Some(session_id);
            let summary_matches = summary_session_id(&summary).as_deref() == Some(session_id);
            if folder_matches || summary_matches {
                return Some(path);
            }
        } else if let Some(found) = find_session_dir(&path, session_id) {
            return Some(found);
        }
    }
    None
}

fn summary_session_id(summary: &Path) -> Option<String> {
    let raw = fs::read_to_string(summary).ok()?;
    let parsed: SummaryFile = serde_json::from_str(&raw).ok()?;
    parsed.info?.id
}

fn read_summary(dir: &Path) -> Result<SummaryFile, String> {
    let raw = fs::read_to_string(dir.join("summary.json")).map_err(|err| err.to_string())?;
    serde_json::from_str(&raw).map_err(|err| err.to_string())
}

#[derive(Debug, Deserialize)]
struct SubagentMetaFile {
    child_session_id: Option<String>,
    subagent_id: Option<String>,
    parent_session_id: Option<String>,
    subagent_type: Option<String>,
    description: Option<String>,
    status: Option<String>,
    effective_model_id: Option<String>,
    duration_ms: Option<u64>,
}

pub(super) fn children_in(dir: &Path) -> Vec<SubagentInfo> {
    let Ok(entries) = fs::read_dir(dir.join("subagents")) else {
        return Vec::new();
    };
    let mut children = entries
        .flatten()
        .filter_map(|entry| {
            let raw = fs::read_to_string(entry.path().join("meta.json")).ok()?;
            let parsed: SubagentMetaFile = serde_json::from_str(&raw).ok()?;
            Some(SubagentInfo {
                session_id: parsed
                    .child_session_id
                    .or(parsed.subagent_id)
                    .unwrap_or_else(|| entry.file_name().to_string_lossy().to_string()),
                parent_session_id: parsed.parent_session_id.unwrap_or_default(),
                subagent_type: parsed.subagent_type.unwrap_or_else(|| "subagent".into()),
                description: parsed
                    .description
                    .filter(|description| !description.is_empty())
                    .unwrap_or_else(|| "Child run".into()),
                status: parsed.status.unwrap_or_else(|| "unknown".into()),
                model_id: parsed.effective_model_id,
                duration_ms: parsed.duration_ms,
            })
        })
        .collect::<Vec<_>>();
    children.sort_by(|left, right| left.session_id.cmp(&right.session_id));
    children
}

pub fn children_of(session_id: &str) -> Result<Vec<SubagentInfo>, String> {
    Ok(children_in(&find_dir(session_id)?))
}

/// Context usage from the public session projection: (used, window, percent).
pub(crate) fn context_of(dir: &Path) -> Option<(u64, u64, u64)> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Signals {
        context_tokens_used: Option<u64>,
        context_window_tokens: Option<u64>,
        context_window_usage: Option<u64>,
    }

    let raw = fs::read_to_string(dir.join("signals.json")).ok()?;
    let signals: Signals = serde_json::from_str(&raw).ok()?;
    let used = signals.context_tokens_used.unwrap_or(0);
    let window = signals.context_window_tokens.unwrap_or(0);
    let percent = signals
        .context_window_usage
        .filter(|percent| *percent > 0)
        .unwrap_or_else(|| used.saturating_mul(100).checked_div(window).unwrap_or(0));
    Some((used, window, percent))
}

pub fn session_detail(session_id: &str) -> Result<SessionDetail, String> {
    let dir = find_dir(session_id)?;
    let summary = read_summary(&dir)?;
    let title = summary
        .generated_title
        .clone()
        .or(summary.session_summary.clone())
        .or(summary.last_turn_summary.clone())
        .filter(|title| !title.is_empty())
        .unwrap_or_else(|| "Untitled".into());
    let cwd = summary
        .info
        .as_ref()
        .and_then(|info| info.cwd.clone())
        .unwrap_or_default();
    let signals = read_signal_counts(&dir);
    let (used, window, percent) = context_of(&dir).unwrap_or((0, 0, 0));
    Ok(SessionDetail {
        session_id: session_id.to_string(),
        title,
        cwd,
        model_id: summary.current_model_id.unwrap_or_default(),
        effort: summary
            .reasoning_effort
            .or_else(|| {
                crate::grok::overlay::session_model(session_id)
                    .map(|preference| preference.effort)
                    .filter(|effort| !effort.is_empty())
            })
            .unwrap_or_default(),
        agent_name: summary.agent_name.unwrap_or_default(),
        created_at: summary.created_at.unwrap_or_default(),
        updated_at: summary
            .last_active_at
            .or(summary.updated_at)
            .unwrap_or_default(),
        turn_count: signals.turn_count,
        user_messages: signals.user_messages,
        tool_calls: signals.tool_calls,
        compaction_count: signals.compaction_count,
        context_used: used,
        context_window: window,
        context_percent: percent,
    })
}

#[derive(Default)]
struct SignalCounts {
    turn_count: u64,
    user_messages: u64,
    tool_calls: u64,
    compaction_count: u64,
}

fn read_signal_counts(dir: &Path) -> SignalCounts {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Signals {
        turn_count: Option<u64>,
        user_message_count: Option<u64>,
        tool_call_count: Option<u64>,
        compaction_count: Option<u64>,
    }

    let Ok(raw) = fs::read_to_string(dir.join("signals.json")) else {
        return SignalCounts::default();
    };
    let Ok(signals) = serde_json::from_str::<Signals>(&raw) else {
        return SignalCounts::default();
    };
    SignalCounts {
        turn_count: signals.turn_count.unwrap_or(0),
        user_messages: signals.user_message_count.unwrap_or(0),
        tool_calls: signals.tool_call_count.unwrap_or(0),
        compaction_count: signals.compaction_count.unwrap_or(0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_home(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "korg-session-index-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[test]
    fn finds_current_session_by_summary_identity() {
        let home = test_home("find");
        let dir = home.join("sessions/2026/08/folder");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("summary.json"),
            r#"{"info":{"id":"session-1","cwd":"/repo"}}"#,
        )
        .unwrap();
        assert_eq!(find_dir_under(&home, "session-1").unwrap(), dir);
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn reads_context_projection() {
        let dir = test_home("context");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("signals.json"),
            r#"{"contextTokensUsed":25,"contextWindowTokens":100}"#,
        )
        .unwrap();
        assert_eq!(context_of(&dir), Some((25, 100, 25)));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn reads_children_without_a_second_cache() {
        let dir = test_home("children");
        let child = dir.join("subagents/child-1");
        fs::create_dir_all(&child).unwrap();
        fs::write(
            child.join("meta.json"),
            r#"{"child_session_id":"child-1","description":"Review","status":"working"}"#,
        )
        .unwrap();
        let children = children_in(&dir);
        assert_eq!(children.len(), 1);
        assert_eq!(children[0].session_id, "child-1");
        let _ = fs::remove_dir_all(dir);
    }
}
