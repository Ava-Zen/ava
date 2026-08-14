//! GitHub Copilot SDK host.
//!
//! Desktop builds embed the official Copilot CLI via `github-copilot-sdk` and
//! expose Tauri commands so the WebView can sign in, start agent sessions, and
//! stream progress. Mobile targets get the same command names as stubs.

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopilotStatus {
  pub available: bool,
  pub reason: String,
  pub gh_cli_available: bool,
  pub bundled_cli: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CopilotRunRequest {
  pub prompt: String,
  #[serde(default)]
  pub github_token: Option<String>,
  #[serde(default)]
  pub model: Option<String>,
  #[serde(default)]
  pub agent: Option<String>,
  #[serde(default)]
  pub workspace: Option<String>,
  #[serde(default)]
  pub allow_writes: bool,
  #[serde(default)]
  pub allow_local_tools: bool,
  #[serde(default)]
  pub timeout_secs: Option<u64>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CopilotEvent {
  pub event: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub text: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopilotRunResult {
  pub content: String,
  pub session_id: Option<String>,
}

#[derive(Default)]
pub struct CopilotHost {
  inner: std::sync::Mutex<HostState>,
}

#[derive(Default)]
struct HostState {
  abort: bool,
}

impl CopilotHost {
  fn request_abort(&self) {
    if let Ok(mut state) = self.inner.lock() {
      state.abort = true;
    }
  }

  fn clear_abort(&self) {
    if let Ok(mut state) = self.inner.lock() {
      state.abort = false;
    }
  }

  fn is_aborted(&self) -> bool {
    self.inner.lock().map(|s| s.abort).unwrap_or(false)
  }
}

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
mod desktop {
  use super::*;
  use github_copilot_sdk::handler::ApproveAllHandler;
  use github_copilot_sdk::permission;
  use github_copilot_sdk::types::{
    CustomAgentConfig, MessageOptions, SessionConfig, SystemMessageConfig,
  };
  use github_copilot_sdk::{Client, ClientOptions, HAS_BUNDLED_CLI};
  use std::path::PathBuf;
  use std::sync::Arc;
  use std::time::Duration;

  const AVA_SYSTEM: &str = "You are GitHub Copilot working on behalf of Ava, a calm voice companion. \
Complete the user's task carefully and thoroughly. Prefer a clear, well-structured written result \
that Ava can speak or show. Do not ask the user to open a terminal; do the work yourself. \
When the user asks about GitHub issues, pull requests, or repositories, use GitHub tools to \
fetch live data. Never invent issues and never pretend to browse github.com as a web page.";

  pub fn status() -> CopilotStatus {
    let bundled = HAS_BUNDLED_CLI || github_copilot_sdk::install_bundled_cli().is_some();
    CopilotStatus {
      available: bundled || system_copilot_on_path(),
      reason: if bundled {
        "Copilot CLI is bundled with Ava.".into()
      } else if system_copilot_on_path() {
        "System Copilot CLI detected.".into()
      } else {
        "Copilot CLI is not available on this device.".into()
      },
      gh_cli_available: read_gh_token().is_some(),
      bundled_cli: bundled,
    }
  }

  pub fn read_gh_auth() -> Option<String> {
    read_gh_token()
  }

  pub async fn run_task(
    host: tauri::State<'_, CopilotHost>,
    request: CopilotRunRequest,
    on_event: Channel<CopilotEvent>,
  ) -> Result<CopilotRunResult, String> {
    host.clear_abort();
    emit(
      &on_event,
      "status",
      Some("Starting GitHub Copilot…"),
    );

    let mut options = ClientOptions::new();
    if let Some(token) = request
      .github_token
      .as_deref()
      .map(str::trim)
      .filter(|t| !t.is_empty())
    {
      options = options.with_github_token(token);
    } else {
      options = options.with_use_logged_in_user(true);
    }
    if let Some(workspace) = workspace_path(&request.workspace) {
      options = options.with_cwd(workspace);
    }

    let client = Client::start(options)
      .await
      .map_err(|err| format!("Could not start Copilot: {err}"))?;

    if host.is_aborted() {
      let _ = client.stop().await;
      return Err("Copilot task cancelled.".into());
    }

    let mut config = SessionConfig::default()
      .with_client_name("ava")
      .with_streaming(true);
    config.model = request
      .model
      .as_deref()
      .map(str::trim)
      .filter(|m| !m.is_empty() && *m != "auto")
      .map(|m| m.to_string())
      .or_else(|| Some("auto".into()));
    config.working_directory = workspace_path(&request.workspace);
    config.include_sub_agent_streaming_events = Some(true);
    config.enable_config_discovery = Some(true);
    config.system_message = Some(SystemMessageConfig::new().with_content(AVA_SYSTEM));
    let allow_local = request.allow_local_tools || request.allow_writes;
    config.custom_agents = Some(ava_agents(allow_local));
    config.agent = request
      .agent
      .as_deref()
      .map(str::trim)
      .filter(|a| !a.is_empty())
      .map(|a| a.to_string());

    if allow_local {
      config = config.with_permission_handler(Arc::new(ApproveAllHandler));
    } else {
      config = config.with_permission_handler(permission::approve_if(is_allowed_without_local_tools));
    }

    let session = match client.create_session(config).await {
      Ok(session) => session,
      Err(err) => {
        let _ = client.stop().await;
        return Err(format!("Could not open a Copilot session: {err}"));
      }
    };

    let session_id = session.id().to_string();
    emit(&on_event, "status", Some("Copilot is working…"));

    let mut events = session.subscribe();
    let event_sink = on_event.clone();
    tauri::async_runtime::spawn(async move {
      while let Ok(event) = events.recv().await {
        let mapped = map_session_event(&event.event_type, &event.data);
        if let Some(payload) = mapped {
          let _ = event_sink.send(payload);
        }
      }
    });

    let timeout = Duration::from_secs(request.timeout_secs.unwrap_or(600).max(30));
    let wait = session.send_and_wait(
      MessageOptions::new(request.prompt.trim()).with_wait_timeout(timeout),
    );

    let aborted = abort_watch(&host);
    tokio::pin!(wait);
    tokio::pin!(aborted);
    let outcome = tokio::select! {
      result = &mut wait => result.map_err(|err| err.to_string()),
      _ = &mut aborted => {
        let _ = session.abort().await;
        Err("Copilot task cancelled.".into())
      }
    };

    let content = match outcome {
      Ok(Some(event)) => event
        .data
        .get("content")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim()
        .to_string(),
      Ok(None) => String::new(),
      Err(err) => {
        let _ = session.disconnect().await;
        let _ = client.stop().await;
        return Err(if host.is_aborted() {
          "Copilot task cancelled.".into()
        } else {
          format!("Copilot could not finish: {err}")
        });
      }
    };

    let _ = session.disconnect().await;
    let _ = client.stop().await;

    if content.is_empty() {
      return Err("Copilot returned an empty result.".into());
    }

    emit(&on_event, "done", Some(content.as_str()));
    Ok(CopilotRunResult {
      content,
      session_id: Some(session_id),
    })
  }

  pub fn abort(host: tauri::State<'_, CopilotHost>) {
    host.request_abort();
  }

  fn ava_agents(allow_writes: bool) -> Vec<CustomAgentConfig> {
    let mut agents = vec![
      CustomAgentConfig::new(
        "researcher",
        "You are Ava's research agent. Explore, read, and summarize. Do not modify files.",
      )
      .with_display_name("Research")
      .with_description("Read-only research, search, and codebase exploration")
      .with_tools(["grep", "glob", "view", "read"])
      .with_infer(true),
      CustomAgentConfig::new(
        "planner",
        "You are Ava's planning agent. Break work into clear steps. Do not modify files unless asked.",
      )
      .with_display_name("Planner")
      .with_description("Plans, outlines, and task breakdowns")
      .with_tools(["grep", "glob", "view", "read"])
      .with_infer(true),
      CustomAgentConfig::new(
        "github",
        "You fetch live GitHub data with GitHub tools for the signed-in user. \
Never invent issues, pull requests, or URLs. Summarize clearly so Ava can speak the result.",
      )
      .with_display_name("GitHub")
      .with_description("Lists issues, pull requests, and repository status from GitHub")
      .with_infer(true),
    ];
    if allow_writes {
      agents.push(
        CustomAgentConfig::new(
          "implementer",
          "You are Ava's implementer. Make targeted file and command changes, then summarize what you did.",
        )
        .with_display_name("Implementer")
        .with_description("Implements code and file changes")
        .with_tools(["view", "read", "edit", "bash"])
        .with_infer(true),
      );
    }
    agents
  }

  fn is_allowed_without_local_tools(
    data: &github_copilot_sdk::types::PermissionRequestData,
  ) -> bool {
    let kind = extra_str(data, "kind")
      .or_else(|| extra_str(data, "type"))
      .unwrap_or_default()
      .to_ascii_lowercase();
    let tool = extra_str(data, "tool")
      .or_else(|| extra_str(data, "toolName"))
      .unwrap_or_default()
      .to_ascii_lowercase();
    let local_kind = matches!(kind.as_str(), "shell" | "write" | "edit");
    let local_tool = matches!(
      tool.as_str(),
      "bash" | "shell" | "edit" | "edit_file" | "write" | "write_file"
    );
    !local_kind && !local_tool
  }

  pub fn pick_folder() -> Option<String> {
    rfd::FileDialog::new()
      .set_title("Choose Copilot workspace")
      .pick_folder()
      .map(|path| path.to_string_lossy().into_owned())
  }

  fn extra_str(
    data: &github_copilot_sdk::types::PermissionRequestData,
    key: &str,
  ) -> Option<String> {
    data
      .extra
      .get(key)
      .and_then(|value| value.as_str())
      .map(|s| s.to_string())
  }

  fn map_session_event(event_type: &str, data: &serde_json::Value) -> Option<CopilotEvent> {
    match event_type {
      "assistant.message_delta" | "assistant.reasoning_delta" => {
        let text = data
          .get("deltaContent")
          .or_else(|| data.get("delta"))
          .and_then(|v| v.as_str())
          .filter(|s| !s.is_empty())?;
        Some(CopilotEvent {
          event: "delta".into(),
          text: Some(text.to_string()),
        })
      }
      "tool.execution_start" => {
        let name = data
          .get("toolName")
          .or_else(|| data.get("name"))
          .and_then(|v| v.as_str())
          .unwrap_or("tool");
        Some(CopilotEvent {
          event: "tool".into(),
          text: Some(format!("Using {name}…")),
        })
      }
      "subagent.started" | "subagent.selected" => {
        let name = data
          .get("agentDisplayName")
          .or_else(|| data.get("agentName"))
          .and_then(|v| v.as_str())
          .unwrap_or("agent");
        Some(CopilotEvent {
          event: "subagent".into(),
          text: Some(format!("{name} started")),
        })
      }
      "subagent.completed" => {
        let name = data
          .get("agentDisplayName")
          .or_else(|| data.get("agentName"))
          .and_then(|v| v.as_str())
          .unwrap_or("agent");
        Some(CopilotEvent {
          event: "subagent".into(),
          text: Some(format!("{name} finished")),
        })
      }
      "session.error" => Some(CopilotEvent {
        event: "error".into(),
        text: data
          .get("message")
          .or_else(|| data.get("error"))
          .and_then(|v| v.as_str())
          .map(|s| s.to_string()),
      }),
      _ => None,
    }
  }

  fn workspace_path(raw: &Option<String>) -> Option<PathBuf> {
    raw
      .as_deref()
      .map(str::trim)
      .filter(|s| !s.is_empty())
      .map(PathBuf::from)
      .or_else(home_dir)
  }

  fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
      .or_else(|| std::env::var_os("HOME"))
      .map(PathBuf::from)
  }

  fn system_copilot_on_path() -> bool {
    which("copilot").is_some() || which("copilot.exe").is_some()
  }

  fn which(name: &str) -> Option<PathBuf> {
    let paths = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&paths) {
      let candidate = dir.join(name);
      if candidate.is_file() {
        return Some(candidate);
      }
    }
    None
  }

  fn read_gh_token() -> Option<String> {
    let output = std::process::Command::new("gh")
      .args(["auth", "token"])
      .output()
      .ok()?;
    if !output.status.success() {
      return None;
    }
    let token = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if token.is_empty() {
      None
    } else {
      Some(token)
    }
  }

  fn emit(channel: &Channel<CopilotEvent>, event: &str, text: Option<&str>) {
    let _ = channel.send(CopilotEvent {
      event: event.into(),
      text: text.map(|s| s.to_string()),
    });
  }

  async fn abort_watch(host: &CopilotHost) {
    loop {
      if host.is_aborted() {
        return;
      }
      tokio::time::sleep(Duration::from_millis(200)).await;
    }
  }

}

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
pub use desktop::{abort as abort_impl, pick_folder, read_gh_auth, run_task, status};

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
mod stub {
  use super::*;

  pub fn status() -> CopilotStatus {
    CopilotStatus {
      available: false,
      reason: "GitHub Copilot agents are available in the desktop app.".into(),
      gh_cli_available: false,
      bundled_cli: false,
    }
  }

  pub fn read_gh_auth() -> Option<String> {
    None
  }

  pub async fn run_task(
    _host: tauri::State<'_, CopilotHost>,
    _request: CopilotRunRequest,
    _on_event: Channel<CopilotEvent>,
  ) -> Result<CopilotRunResult, String> {
    Err("GitHub Copilot agents are available in the desktop app.".into())
  }

  pub fn abort(_host: tauri::State<'_, CopilotHost>) {}

  pub fn pick_folder() -> Option<String> {
    None
  }
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
pub use stub::{abort as abort_impl, pick_folder, read_gh_auth, run_task, status};

#[tauri::command]
pub fn copilot_status() -> CopilotStatus {
  status()
}

#[tauri::command]
pub fn copilot_read_gh_auth() -> Option<String> {
  read_gh_auth()
}

#[tauri::command]
pub fn copilot_pick_folder() -> Option<String> {
  pick_folder()
}

#[tauri::command]
pub async fn copilot_run_task(
  host: tauri::State<'_, CopilotHost>,
  request: CopilotRunRequest,
  on_event: Channel<CopilotEvent>,
) -> Result<CopilotRunResult, String> {
  run_task(host, request, on_event).await
}

#[tauri::command]
pub fn copilot_abort(host: tauri::State<'_, CopilotHost>) {
  abort_impl(host);
}
