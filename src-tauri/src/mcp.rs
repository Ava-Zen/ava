//! Minimal MCP (Model Context Protocol) server that lets other local agents
//! (Claude Desktop, GitHub Copilot, etc.) call Ava to speak text aloud.
//!
//! TTS itself runs in the Angular webview (Kokoro / system speech). This module
//! only hosts a tiny localhost HTTP server speaking the MCP "Streamable HTTP"
//! transport. When a `speak` tool call arrives it forwards the text to the
//! webview through a Tauri event and waits for the front-end to acknowledge that
//! playback finished. No audio is processed in Rust.

use std::{
  collections::HashMap,
  sync::{
    atomic::{AtomicU64, Ordering},
    mpsc::{self, Sender},
    Mutex,
  },
  time::Duration,
};

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tiny_http::{Header, Method, Response, Server};

/// Loopback-only port chosen to avoid clashing with common dev servers. 7456 is
/// not registered to any well-known service.
pub const MCP_PORT: u16 = 7456;

/// How long a `speak` call waits for the webview to finish playback.
const SPEAK_TIMEOUT: Duration = Duration::from_secs(120);

/// Shared bridge between the HTTP server and the webview front-end. Each pending
/// speak request parks on a one-shot channel until the UI reports completion.
pub struct McpBridge {
  next_id: AtomicU64,
  pending: Mutex<HashMap<u64, Sender<bool>>>,
}

impl McpBridge {
  fn new() -> Self {
    Self {
      next_id: AtomicU64::new(1),
      pending: Mutex::new(HashMap::new()),
    }
  }

  /// Called by the `mcp_tts_complete` command from the webview.
  pub fn complete(&self, request_id: u64, ok: bool) {
    if let Some(tx) = self.pending.lock().unwrap().remove(&request_id) {
      let _ = tx.send(ok);
    }
  }
}

#[derive(Deserialize)]
struct SpeakArgs {
  text: String,
  #[serde(default)]
  voice: Option<String>,
}

/// Starts the MCP HTTP server on a background thread. Desktop only.
pub fn start(app: AppHandle) {
  app.manage(McpBridge::new());

  std::thread::spawn(move || {
    let addr = format!("127.0.0.1:{MCP_PORT}");
    let server = match Server::http(&addr) {
      Ok(server) => server,
      Err(error) => {
        log::warn!("Ava MCP server could not bind {addr}: {error}");
        return;
      }
    };
    log::info!("Ava MCP server listening on http://{addr}");

    for mut request in server.incoming_requests() {
      if request.method() != &Method::Post {
        let _ = request.respond(Response::from_string("MCP endpoint expects POST").with_status_code(405));
        continue;
      }

      let mut body = String::new();
      if request.as_reader().read_to_string(&mut body).is_err() {
        let _ = request.respond(Response::from_string("bad request").with_status_code(400));
        continue;
      }

      let parsed: Value = match serde_json::from_str(&body) {
        Ok(value) => value,
        Err(_) => {
          let _ = request.respond(json_response(rpc_error(Value::Null, -32700, "Parse error")));
          continue;
        }
      };

      // Notifications (no id) get an empty 202 ack.
      let id = parsed.get("id").cloned();
      if id.is_none() {
        let _ = request.respond(Response::from_string("").with_status_code(202));
        continue;
      }

      let response = handle_rpc(&app, &parsed, id.unwrap());
      let _ = request.respond(json_response(response));
    }
  });
}

fn handle_rpc(app: &AppHandle, req: &Value, id: Value) -> Value {
  let method = req.get("method").and_then(Value::as_str).unwrap_or("");
  match method {
    "initialize" => rpc_result(
      id,
      json!({
        "protocolVersion": "2024-11-05",
        "capabilities": { "tools": {} },
        "serverInfo": { "name": "ava-tts", "version": env!("CARGO_PKG_VERSION") }
      }),
    ),
    "tools/list" => rpc_result(id, json!({ "tools": tool_definitions() })),
    "tools/call" => handle_tool_call(app, req, id),
    "ping" => rpc_result(id, json!({})),
    _ => rpc_error(id, -32601, "Method not found"),
  }
}

fn handle_tool_call(app: &AppHandle, req: &Value, id: Value) -> Value {
  let params = req.get("params").cloned().unwrap_or(Value::Null);
  let name = params.get("name").and_then(Value::as_str).unwrap_or("");
  let args = params.get("arguments").cloned().unwrap_or(json!({}));

  match name {
    "speak" => {
      let parsed: SpeakArgs = match serde_json::from_value(args) {
        Ok(value) => value,
        Err(error) => return rpc_error(id, -32602, &format!("Invalid arguments: {error}")),
      };
      if parsed.text.trim().is_empty() {
        return rpc_error(id, -32602, "`text` must not be empty");
      }
      match speak(app, &parsed.text, parsed.voice.as_deref()) {
        Ok(()) => tool_text(id, "Ava spoke the text aloud."),
        Err(error) => tool_error(id, &error),
      }
    }
    "list_voices" => {
      let voices = voice_catalog();
      tool_text(id, &serde_json::to_string_pretty(&voices).unwrap_or_default())
    }
    _ => rpc_error(id, -32602, "Unknown tool"),
  }
}

/// Forwards text to the webview and blocks until playback finishes or times out.
fn speak(app: &AppHandle, text: &str, voice: Option<&str>) -> Result<(), String> {
  let bridge = app.state::<McpBridge>();
  let request_id = bridge.next_id.fetch_add(1, Ordering::SeqCst);
  let (tx, rx) = mpsc::channel::<bool>();
  bridge.pending.lock().unwrap().insert(request_id, tx);

  app
    .emit(
      "mcp-tts-request",
      json!({ "id": request_id, "text": text, "voice": voice }),
    )
    .map_err(|e| format!("Failed to reach Ava window: {e}"))?;

  match rx.recv_timeout(SPEAK_TIMEOUT) {
    Ok(true) => Ok(()),
    Ok(false) => Err("Ava could not speak the text.".into()),
    Err(_) => {
      bridge.pending.lock().unwrap().remove(&request_id);
      Err("Timed out waiting for Ava to finish speaking.".into())
    }
  }
}

fn tool_definitions() -> Value {
  json!([
    {
      "name": "speak",
      "description": "Speak text aloud through Ava's on-device voice. Use this to give an agent a natural spoken voice.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "text": { "type": "string", "description": "The text Ava should say." },
          "voice": { "type": "string", "description": "Optional Kokoro voice id (see list_voices)." }
        },
        "required": ["text"]
      }
    },
    {
      "name": "list_voices",
      "description": "List the Kokoro voices Ava can speak with.",
      "inputSchema": { "type": "object", "properties": {} }
    }
  ])
}

fn voice_catalog() -> Value {
  json!([
    { "id": "af_bella", "name": "Bella", "accent": "American · Female" },
    { "id": "af_nicole", "name": "Nicole", "accent": "American · Female" },
    { "id": "am_adam", "name": "Adam", "accent": "American · Male" },
    { "id": "am_puck", "name": "Puck", "accent": "American · Male" },
    { "id": "am_eric", "name": "Eric", "accent": "American · Male" },
    { "id": "bf_isabella", "name": "Isabella", "accent": "British · Female" },
    { "id": "bm_george", "name": "George", "accent": "British · Male" }
  ])
}

fn json_response(value: Value) -> Response<std::io::Cursor<Vec<u8>>> {
  let body = value.to_string();
  let header = Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap();
  Response::from_string(body).with_header(header)
}

fn rpc_result(id: Value, result: Value) -> Value {
  json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn rpc_error(id: Value, code: i64, message: &str) -> Value {
  json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn tool_text(id: Value, text: &str) -> Value {
  rpc_result(id, json!({ "content": [ { "type": "text", "text": text } ] }))
}

fn tool_error(id: Value, message: &str) -> Value {
  rpc_result(
    id,
    json!({ "content": [ { "type": "text", "text": message } ], "isError": true }),
  )
}
