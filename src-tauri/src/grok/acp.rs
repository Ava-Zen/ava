use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::Duration;

use serde_json::{json, Value};

/// Wakes the event pump when any agent writes a line or exits.
#[derive(Clone)]
pub struct WakeHandle(Arc<(Mutex<bool>, Condvar)>);

impl WakeHandle {
    pub fn new() -> Self {
        Self(Arc::new((Mutex::new(false), Condvar::new())))
    }

    pub fn notify(&self) {
        if let Ok(mut flagged) = self.0 .0.lock() {
            *flagged = true;
            self.0 .1.notify_one();
        }
    }

    pub fn wait_timeout(&self, timeout: Duration) {
        let Ok(mut flagged) = self.0 .0.lock() else {
            return;
        };
        if *flagged {
            *flagged = false;
            return;
        }
        if let Ok((mut flagged, _)) = self.0 .1.wait_timeout(flagged, timeout) {
            *flagged = false;
        }
    }
}

type Pending = Arc<Mutex<HashMap<u64, Sender<Result<Value, String>>>>>;

fn fail_pending(pending: &Pending, reason: &str) {
    let waiters = match pending.lock() {
        Ok(mut map) => map.drain().map(|(_, waiter)| waiter).collect::<Vec<_>>(),
        Err(_) => return,
    };
    for waiter in waiters {
        let _ = waiter.send(Err(reason.to_string()));
    }
}

/// A registered waiter that unregisters itself. Dropping it — on timeout as
/// much as on success — takes the id out of `pending`, so an abandoned request
/// cannot leak a sender for the life of the child.
pub struct RpcWaiter {
    id: u64,
    pending: Pending,
    rx: Receiver<Result<Value, String>>,
}

impl RpcWaiter {
    pub fn recv_timeout(
        &self,
        timeout: Duration,
    ) -> Result<Result<Value, String>, RecvTimeoutError> {
        self.rx.recv_timeout(timeout)
    }
}

impl Drop for RpcWaiter {
    fn drop(&mut self) {
        if let Ok(mut map) = self.pending.lock() {
            map.remove(&self.id);
        }
    }
}

pub type RpcTask = tauri::async_runtime::JoinHandle<Result<Value, String>>;

/// ACP extension methods are named `x.ai/*` in the typed API and carried as
/// `_x.ai/*` on JSON-RPC. Keep that encoding at the transport boundary.
fn wire_method(method: &str) -> String {
    if method.starts_with("x.ai/") {
        format!("_{method}")
    } else {
        method.to_string()
    }
}

/// Most extension handlers return the typed payload inside `{ result: ... }`;
/// a few direct handlers (notably auth) already return the payload itself.
fn response_payload(method: &str, value: Value) -> Value {
    if method.starts_with("x.ai/") {
        if let Some(payload) = value.get("result") {
            return payload.clone();
        }
    }
    value
}

/// Wait for a registered request without holding `AppState`; the event pump
/// needs that lock to deliver the response.
pub fn spawn_rpc_wait(waiter: RpcWaiter, method: &str, timeout: Duration) -> RpcTask {
    let label = method.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let value = waiter.recv_timeout(timeout).map_err(|err| match err {
            RecvTimeoutError::Timeout => format!("timeout waiting for {label}"),
            RecvTimeoutError::Disconnected => "agent transport closed".into(),
        })??;
        Ok(response_payload(&label, value))
    })
}

pub async fn finish_rpc(task: RpcTask) -> Result<Value, String> {
    task.await.map_err(|err| err.to_string())?
}

pub async fn wait_rpc(waiter: RpcWaiter, method: &str, timeout: Duration) -> Result<Value, String> {
    finish_rpc(spawn_rpc_wait(waiter, method, timeout)).await
}

pub struct AcpAgent {
    child: Option<Child>,
    /// Writes go to a dedicated thread. A blocking `write` here would be held
    /// under `AppState` by every caller, and the event pump needs that same
    /// lock to drain stdout — a full pipe would deadlock the two against each
    /// other now that one child carries every session.
    outbox: Sender<Value>,
    pub incoming: Receiver<Value>,
    next_id: u64,
    pending: Pending,
    /// Set once the transport can carry nothing more: stdout reached EOF or a
    /// write failed. Process exit is not enough on its own — the child can
    /// outlive its own pipes.
    broken: Arc<AtomicBool>,
    reaped: bool,
}

impl AcpAgent {
    /// `--leader` makes this child a proxy onto the shared Grok leader instead
    /// of its own agent: sessions survive Korg restarts, the TUI can attach to
    /// the same session, and one child can hold all of them.
    pub fn spawn(bin: &Path, wake: Option<WakeHandle>) -> Result<Self, String> {
        let mut cmd = crate::grok::grok_bin::command_agent(bin);
        cmd.args(["agent", "--leader", "stdio"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = cmd.spawn().map_err(|e| format!("spawn grok agent: {e}"))?;
        let stdin = child.stdin.take().ok_or("agent stdin missing")?;
        let stdout = child.stdout.take().ok_or("agent stdout missing")?;
        let stderr = child.stderr.take();
        if let Some(err) = stderr {
            thread::spawn(move || {
                let reader = BufReader::new(err);
                // `map_while` stops on a read error. `flatten` would spin.
                for line in reader.lines().map_while(Result::ok) {
                    eprintln!("[grok-agent] {line}");
                }
            });
        }
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let broken = Arc::new(AtomicBool::new(false));
        let (out_tx, out_rx) = mpsc::channel::<Value>();
        let broken_w = broken.clone();
        let pending_w = pending.clone();
        let wake_w = wake.clone();
        thread::spawn(move || {
            let mut stdin = stdin;
            for msg in out_rx {
                if writeln!(stdin, "{msg}").is_err() || stdin.flush().is_err() {
                    break;
                }
            }
            broken_w.store(true, Ordering::Relaxed);
            fail_pending(&pending_w, "agent transport write failed");
            if let Some(wake) = &wake_w {
                wake.notify();
            }
        });
        let (tx, rx) = mpsc::channel::<Value>();
        let pending_r = pending.clone();
        let broken_r = broken.clone();
        let wake_r = wake;
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                let Ok(v) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                // session/prompt must stay off the pending map (`send_rpc`). A
                // waiter here would swallow JSON-RPC errors. If it later uses
                // begin_request, emit acp://prompt-error on the waiter Err
                // path before returning — do not silently swallow.
                if let Some(id) = v.get("id").and_then(|i| i.as_u64()) {
                    if v.get("result").is_some() || v.get("error").is_some() {
                        if let Some(wait) =
                            pending_r.lock().ok().and_then(|mut map| map.remove(&id))
                        {
                            if let Some(err) = v.get("error") {
                                let _ = wait.send(Err(err.to_string()));
                            } else {
                                let _ =
                                    wait.send(Ok(v.get("result").cloned().unwrap_or(Value::Null)));
                            }
                            continue;
                        }
                    }
                }
                let _ = tx.send(v);
                if let Some(wake) = &wake_r {
                    wake.notify();
                }
            }
            // EOF or a read error: every line that will ever arrive has been
            // queued, so this is the ordered point at which the link is done.
            broken_r.store(true, Ordering::Relaxed);
            fail_pending(&pending_r, "agent transport closed");
            if let Some(wake) = &wake_r {
                wake.notify();
            }
        });
        Ok(Self {
            child: Some(child),
            outbox: out_tx,
            incoming: rx,
            next_id: 1,
            pending,
            broken,
            reaped: false,
        })
    }

    pub fn shutdown(&mut self) {
        if self.reaped {
            return;
        }
        self.reaped = true;
        let Some(mut child) = self.child.take() else {
            return;
        };
        crate::grok::platform::kill_process_tree(child.id());
        let _ = child.kill();
        // Drop often runs under AppState. SIGKILL is already sent; reap off
        // this thread so a stuck wait cannot freeze the window.
        thread::spawn(move || {
            let _ = child.wait();
        });
    }

    pub fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        self.request_for(method, params, Duration::from_secs(45))
    }

    pub fn request_for(
        &mut self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        let waiter = self.begin_request(method, params)?;
        waiter.recv_timeout(timeout).map_err(|err| match err {
            RecvTimeoutError::Timeout => format!("timeout waiting for {method}"),
            RecvTimeoutError::Disconnected => "agent transport closed".into(),
        })?
    }

    /// Write a JSON-RPC request and return the waiter. Caller must wait
    /// *without* holding AppState — `session/prompt` can take a full turn.
    pub fn begin_request(&mut self, method: &str, params: Value) -> Result<RpcWaiter, String> {
        let id = self.next_id;
        self.next_id += 1;
        let (tx, rx) = mpsc::channel();
        self.pending
            .lock()
            .map_err(|e| e.to_string())?
            .insert(id, tx);
        let waiter = RpcWaiter {
            id,
            pending: self.pending.clone(),
            rx,
        };
        self.write(json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": wire_method(method),
            "params": params
        }))?;
        Ok(waiter)
    }

    /// Fire a request and ignore the eventual result (stream updates carry the turn).
    pub fn send_rpc(&mut self, method: &str, params: Value) -> Result<u64, String> {
        let id = self.next_id;
        self.next_id += 1;
        self.write(json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": wire_method(method),
            "params": params
        }))?;
        Ok(id)
    }

    /// Fire a JSON-RPC notification (no `id`). ACP `session/cancel` is a
    /// notification (same `user_interrupt` as TUI Esc); Grok rejects a
    /// cancel *request* with Method not found by design.
    pub fn send_notification(&self, method: &str, params: Value) -> Result<(), String> {
        self.write(crate::grok::acp_msg::jsonrpc_notification(
            &wire_method(method),
            params,
        ))
    }

    /// First press must stop the current turn. Grok owns follow-up queue state,
    /// so cancellation uses only the authoritative ACP notification. JSON-RPC
    /// request ids are reply-routing bookkeeping and must never be fanned out
    /// here: a session can have accepted queued prompts still in flight.
    pub fn cancel_session(
        &self,
        session_id: &str,
        cancel_trigger: Option<&str>,
    ) -> Result<(), String> {
        let params = crate::grok::acp_msg::session_cancel_params(session_id, cancel_trigger);
        self.send_notification("session/cancel", params)
    }

    pub fn try_incoming(&self) -> Option<Value> {
        self.incoming.try_recv().ok()
    }

    /// A closed transport counts as death even while the process lingers:
    /// otherwise prompts keep being written into a pipe nobody reads and no
    /// session is ever told. Process exit stays as the backstop.
    pub fn dead(&mut self) -> bool {
        self.broken.load(Ordering::Relaxed)
            || match self.child.as_mut() {
                Some(child) => matches!(child.try_wait(), Ok(Some(_)) | Err(_)),
                None => true,
            }
    }

    pub fn respond(&self, id: Value, result: Value) -> Result<(), String> {
        self.write(json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": result
        }))
    }

    pub fn respond_error(&self, id: Value, code: i64, message: &str) -> Result<(), String> {
        self.write(json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": code, "message": message }
        }))
    }

    fn write(&self, msg: Value) -> Result<(), String> {
        if self.broken.load(Ordering::Relaxed) {
            return Err("agent transport closed".into());
        }
        self.outbox
            .send(msg)
            .map_err(|_| "agent transport closed".to_string())
    }

    pub fn initialize(&mut self) -> Result<Value, String> {
        self.request(
            "initialize",
            json!({
                "protocolVersion": 1,
                "clientInfo": {
                    "name": crate::grok::acp_msg::CLIENT_ID,
                    "title": "Ava",
                    "version": env!("CARGO_PKG_VERSION")
                },
                "clientCapabilities": {
                    "fs": { "readTextFile": false, "writeTextFile": false },
                    "terminal": false,
                    "_meta": {
                        "x.ai/folderTrust": { "interactive": true }
                    }
                },
                "_meta": { "clientIdentifier": crate::grok::acp_msg::CLIENT_ID }
            }),
        )
    }
}

impl Drop for AcpAgent {
    fn drop(&mut self) {
        self.shutdown();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_agent() -> (AcpAgent, Receiver<Value>) {
        let (outbox, outbound) = mpsc::channel();
        let (_incoming_tx, incoming) = mpsc::channel();
        (
            AcpAgent {
                child: None,
                outbox,
                incoming,
                next_id: 1,
                pending: Arc::new(Mutex::new(HashMap::new())),
                broken: Arc::new(AtomicBool::new(false)),
                reaped: false,
            },
            outbound,
        )
    }

    #[test]
    fn extension_wire_is_encoded_once_at_the_transport_boundary() {
        assert_eq!(wire_method("x.ai/auth/info"), "_x.ai/auth/info");
        assert_eq!(wire_method("session/list"), "session/list");
        assert_eq!(wire_method("_x.ai/auth/info"), "_x.ai/auth/info");
    }

    #[test]
    fn extension_result_envelope_is_unwrapped_once() {
        assert_eq!(
            response_payload(
                "x.ai/sessions/list",
                json!({ "result": { "sessions": [] } })
            ),
            json!({ "sessions": [] })
        );
        assert_eq!(
            response_payload("x.ai/auth/info", json!({ "methodId": "cached_token" })),
            json!({ "methodId": "cached_token" })
        );
        assert_eq!(
            response_payload("session/list", json!({ "result": { "sessions": [] } })),
            json!({ "result": { "sessions": [] } })
        );
    }

    #[test]
    fn transport_failure_drains_every_waiter_immediately() {
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let mut receivers = Vec::new();
        for id in [1, 2, 3] {
            let (tx, rx) = mpsc::channel();
            pending.lock().unwrap().insert(id, tx);
            receivers.push(rx);
        }

        fail_pending(&pending, "transport gone");

        assert!(pending.lock().unwrap().is_empty());
        for rx in receivers {
            assert_eq!(
                rx.recv_timeout(Duration::from_millis(10)).unwrap(),
                Err("transport gone".into())
            );
        }
    }

    #[test]
    fn cancelling_with_running_and_queued_prompts_sends_only_session_cancel() {
        let (mut agent, outbound) = test_agent();
        let running = agent
            .send_rpc(
                "session/prompt",
                json!({ "sessionId": "s1", "prompt": "running" }),
            )
            .unwrap();
        let queued = agent
            .send_rpc(
                "session/prompt",
                json!({ "sessionId": "s1", "prompt": "queued" }),
            )
            .unwrap();
        assert_ne!(running, queued);
        let _ = outbound.recv_timeout(Duration::from_millis(10)).unwrap();
        let _ = outbound.recv_timeout(Duration::from_millis(10)).unwrap();

        agent.cancel_session("s1", Some("mouse")).unwrap();

        let cancel = outbound.recv_timeout(Duration::from_millis(10)).unwrap();
        assert_eq!(cancel["method"], "session/cancel");
        assert_eq!(cancel["params"]["sessionId"], "s1");
        assert!(cancel.get("id").is_none());
        assert!(matches!(
            outbound.try_recv(),
            Err(mpsc::TryRecvError::Empty)
        ));
        assert!(!cancel.to_string().contains("$/cancelRequest"));
    }
}
