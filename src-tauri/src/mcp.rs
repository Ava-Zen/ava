//! MCP (Model Context Protocol) server so other local agents — Grok Bot,
//! Claude Desktop, GitHub Copilot, Cursor — can borrow Ava's voice.
//!
//! TTS runs in the Angular webview. This module hosts a localhost Streamable
//! HTTP endpoint (POST JSON-RPC, GET SSE/info, OPTIONS CORS).

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

/// Loopback-only port chosen to avoid clashing with common dev servers.
pub const MCP_PORT: u16 = 7456;

const SPEAK_TIMEOUT: Duration = Duration::from_secs(120);

const SUPPORTED_PROTOCOL_VERSIONS: &[&str] = &[
  "2024-11-05",
  "2025-03-26",
  "2025-06-18",
  "2025-11-25",
  "2026-06-18",
  "2026-07-28",
];

const DEFAULT_PROTOCOL_VERSION: &str = "2025-06-18";

const SERVER_INSTRUCTIONS: &str = "\
Ava is a local voice companion. Call list_voices to see speakers, speak to \
say text aloud on this machine, stop_speaking to interrupt, and get_status \
to check that Ava is open. Prefer speak for any request to talk, announce, \
or read something out loud.";

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
      let method = request.method().clone();
      let accept = header_value(&request, "Accept");
      let wants_sse = accept.to_ascii_lowercase().contains("text/event-stream");

      match method {
        Method::Options => {
          let _ = request.respond(with_cors(Response::from_string("").with_status_code(204)));
        }
        Method::Get => {
          if wants_sse {
            let _ = request.respond(with_cors(sse_keepalive()));
          } else {
            let _ = request.respond(with_cors(json_response(server_manifest())));
          }
        }
        Method::Delete => {
          let _ = request.respond(with_cors(Response::from_string("").with_status_code(200)));
        }
        Method::Post => {
          let mut body = String::new();
          if request.as_reader().read_to_string(&mut body).is_err() {
            let _ = request.respond(with_cors(
              Response::from_string("bad request").with_status_code(400),
            ));
            continue;
          }

          let parsed: Value = match serde_json::from_str(&body) {
            Ok(value) => value,
            Err(_) => {
              let _ = request.respond(with_cors(json_response(rpc_error(
                Value::Null,
                -32700,
                "Parse error",
              ))));
              continue;
            }
          };

          let id = parsed.get("id").cloned();
          if id.is_none() {
            let _ = request.respond(with_cors(Response::from_string("").with_status_code(202)));
            continue;
          }

          let is_initialize = parsed.get("method").and_then(Value::as_str) == Some("initialize");
          let response = handle_rpc(&app, &parsed, id.unwrap());
          let mut http = with_cors(json_response(response));
          if is_initialize {
            http = http.with_header(header("Mcp-Session-Id", "ava-local"));
            http = http.with_header(header("MCP-Protocol-Version", DEFAULT_PROTOCOL_VERSION));
          }
          let _ = request.respond(http);
        }
        _ => {
          let _ = request.respond(with_cors(
            Response::from_string("Method not allowed").with_status_code(405),
          ));
        }
      }
    }
  });
}

fn handle_rpc(app: &AppHandle, req: &Value, id: Value) -> Value {
  let method = req.get("method").and_then(Value::as_str).unwrap_or("");
  match method {
    "initialize" => {
      let requested = req
        .pointer("/params/protocolVersion")
        .and_then(Value::as_str)
        .unwrap_or(DEFAULT_PROTOCOL_VERSION);
      let protocol_version = if SUPPORTED_PROTOCOL_VERSIONS.contains(&requested) {
        requested
      } else {
        DEFAULT_PROTOCOL_VERSION
      };
      rpc_result(
        id,
        json!({
          "protocolVersion": protocol_version,
          "capabilities": {
            "tools": { "listChanged": false },
            "resources": {},
            "prompts": {}
          },
          "serverInfo": {
            "name": "ava-voice",
            "title": "Ava Voice",
            "version": env!("CARGO_PKG_VERSION")
          },
          "instructions": SERVER_INSTRUCTIONS
        }),
      )
    }
    "tools/list" => rpc_result(id, json!({ "tools": tool_definitions() })),
    "tools/call" => handle_tool_call(app, req, id),
    "resources/list" => rpc_result(id, json!({ "resources": [] })),
    "prompts/list" => rpc_result(id, json!({ "prompts": [] })),
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
      tool_text(id, &serde_json::to_string_pretty(&voice_catalog()).unwrap_or_default())
    }
    "stop_speaking" => {
      let _ = app.emit("mcp-tts-stop", json!({}));
      tool_text(id, "Ava stopped speaking.")
    }
    "get_status" => {
      tool_text(
        id,
        "Ava is open and ready. Tools: speak, list_voices, stop_speaking, get_status. \
Call list_voices to see speaker ids, then speak with optional voice.",
      )
    }
    _ => rpc_error(id, -32602, "Unknown tool"),
  }
}

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
      "description": "Speak text aloud through Ava on this computer. Use whenever the user wants something said, announced, read, or spoken. Returns after playback finishes.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "text": { "type": "string", "description": "The words Ava should say." },
          "voice": { "type": "string", "description": "Optional speaker id from list_voices, e.g. carina, eve, af_bella." }
        },
        "required": ["text"]
      }
    },
    {
      "name": "list_voices",
      "description": "List Ava's available speakers (Grok cloud voices and on-device Kokoro voices) with ids to pass to speak.",
      "inputSchema": { "type": "object", "properties": {} }
    },
    {
      "name": "stop_speaking",
      "description": "Interrupt Ava if she is currently talking.",
      "inputSchema": { "type": "object", "properties": {} }
    },
    {
      "name": "get_status",
      "description": "Check that Ava is running and which voice tools are available.",
      "inputSchema": { "type": "object", "properties": {} }
    }
  ])
}

fn voice_catalog() -> Value {
  json!([
    { "id": "carina", "name": "Carina", "family": "grok", "note": "Default Grok voice when signed in" },
    { "id": "eve", "name": "Eve", "family": "grok" },
    { "id": "ara", "name": "Ara", "family": "grok" },
    { "id": "luna", "name": "Luna", "family": "grok" },
    { "id": "leo", "name": "Leo", "family": "grok" },
    { "id": "rex", "name": "Rex", "family": "grok" },
    { "id": "sal", "name": "Sal", "family": "grok" },
    { "id": "af_bella", "name": "Bella", "family": "kokoro", "accent": "American · Female" },
    { "id": "af_nicole", "name": "Nicole", "family": "kokoro", "accent": "American · Female" },
    { "id": "am_adam", "name": "Adam", "family": "kokoro", "accent": "American · Male" },
    { "id": "am_puck", "name": "Puck", "family": "kokoro", "accent": "American · Male" },
    { "id": "am_eric", "name": "Eric", "family": "kokoro", "accent": "American · Male" },
    { "id": "bf_isabella", "name": "Isabella", "family": "kokoro", "accent": "British · Female" },
    { "id": "bm_george", "name": "George", "family": "kokoro", "accent": "British · Male" }
  ])
}

fn server_manifest() -> Value {
  json!({
    "name": "ava-voice",
    "title": "Ava Voice",
    "transport": "streamable-http",
    "url": format!("http://127.0.0.1:{MCP_PORT}"),
    "instructions": SERVER_INSTRUCTIONS,
    "tools": tool_definitions()
  })
}

fn header_value(request: &tiny_http::Request, name: &str) -> String {
  let needle = name.to_ascii_lowercase();
  request
    .headers()
    .iter()
    .find(|h| format!("{}", h.field).eq_ignore_ascii_case(&needle))
    .map(|h| h.value.as_str().to_string())
    .unwrap_or_default()
}

fn header(name: &str, value: &str) -> Header {
  Header::from_bytes(name.as_bytes(), value.as_bytes()).expect("valid header")
}

fn with_cors<R: std::io::Read>(response: Response<R>) -> Response<R> {
  response
    .with_header(header("Access-Control-Allow-Origin", "*"))
    .with_header(header(
      "Access-Control-Allow-Methods",
      "GET, POST, OPTIONS, DELETE",
    ))
    .with_header(header(
      "Access-Control-Allow-Headers",
      "Content-Type, Accept, MCP-Protocol-Version, Mcp-Session-Id, Last-Event-ID",
    ))
    .with_header(header(
      "Access-Control-Expose-Headers",
      "Mcp-Session-Id, MCP-Protocol-Version",
    ))
}

fn json_response(value: Value) -> Response<std::io::Cursor<Vec<u8>>> {
  let body = value.to_string();
  Response::from_string(body).with_header(header("Content-Type", "application/json"))
}

fn sse_keepalive() -> Response<std::io::Cursor<Vec<u8>>> {
  Response::from_string(": ava-voice ready\n\n")
    .with_header(header("Content-Type", "text/event-stream"))
    .with_header(header("Cache-Control", "no-cache"))
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
