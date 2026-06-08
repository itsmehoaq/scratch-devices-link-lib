//! JSON-RPC 2.0 base session. Port of `src/session/session.js`.
//!
//! Distinguishes request (has `method`) from response (has `result`/`error`),
//! tracks an auto-incrementing id counter and a pending-completion map for
//! server→client requests, and builds the response envelope with the JS quirk
//! preserved (`error` set only when truthy; otherwise `result`).

use std::collections::HashMap;

use serde_json::{json, Value};
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::oneshot;

/// Outbound text frame sink (to the websocket writer task).
pub type OutSink = UnboundedSender<String>;

/// Completion callback delivered when a server→client request gets a response.
/// Receives `(result, error)` — matching the JS `completion(result, error)`
/// convention (result first, error second).
pub type Completion = oneshot::Sender<(Value, Value)>;

/// Classification of an inbound JSON-RPC frame.
pub enum Inbound {
    /// A client request: (method, params, id-or-null).
    Request {
        method: String,
        params: Value,
        id: Value,
    },
    /// A response to a server-initiated request: (id, result, error).
    Response {
        id: Value,
        result: Value,
        error: Value,
    },
}

/// Base JSON-RPC session state shared by the serialport session.
pub struct Session {
    next_id: u64,
    out: OutSink,
    completions: HashMap<u64, Completion>,
}

impl Session {
    pub fn new(out: OutSink) -> Self {
        Self {
            next_id: 0,
            out,
            completions: HashMap::new(),
        }
    }

    pub fn out(&self) -> &OutSink {
        &self.out
    }

    fn next_id(&mut self) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }

    /// Port of `makeResponse`: `error` only when truthy, else `result`.
    pub fn make_response(id: &Value, result: Value, error: Value) -> Value {
        let mut resp = json!({ "id": id, "jsonrpc": "2.0" });
        if is_truthy(&error) {
            resp["error"] = error;
        } else {
            resp["result"] = result;
        }
        resp
    }

    /// Send a response envelope for a client request id.
    pub fn send_response(&self, id: &Value, result: Value, error: Value) {
        let resp = Self::make_response(id, result, error);
        let _ = self.out.send(resp.to_string());
    }

    /// Parse + classify an inbound frame. Port of `didReceiveMessage` routing.
    /// Returns Err(message) on protocol violations (caller replies with error).
    pub fn parse_inbound(message: &str) -> Result<Inbound, String> {
        let json: Value =
            serde_json::from_str(message).map_err(|e| format!("parse error: {}", e))?;
        if json.get("jsonrpc").and_then(|v| v.as_str()) != Some("2.0") {
            return Err("unrecognized JSON-RPC version string".to_string());
        }
        let id = json.get("id").cloned().unwrap_or(Value::Null);
        if let Some(method) = json.get("method").and_then(|v| v.as_str()) {
            Ok(Inbound::Request {
                method: method.to_string(),
                params: json.get("params").cloned().unwrap_or_else(|| json!({})),
                id,
            })
        } else {
            let result = json.get("result").cloned().unwrap_or(Value::Null);
            let error = json.get("error").cloned().unwrap_or(Value::Null);
            if is_truthy(&result) || is_truthy(&error) {
                Ok(Inbound::Response { id, result, error })
            } else {
                Err("message is neither request nor response".to_string())
            }
        }
    }

    /// Dispatch a response to its registered completion. Port of `didReceiveResponse`.
    pub fn handle_response(&mut self, id: &Value, result: Value, error: Value) {
        let key = match id.as_u64() {
            Some(k) => k,
            None => return,
        };
        if let Some(tx) = self.completions.remove(&key) {
            if is_truthy(&error) {
                let _ = tx.send((Value::Null, error));
            } else {
                let _ = tx.send((result, Value::Null));
            }
        }
    }

    /// Port of `sendRemoteRequest`. When `completion` is Some, an id is assigned
    /// and the receiver resolves when the client responds.
    pub fn send_remote_request(
        &mut self,
        method: &str,
        params: Option<Value>,
        completion: Option<Completion>,
    ) {
        let mut request = json!({ "jsonrpc": "2.0", "method": method });
        if let Some(p) = params {
            request["params"] = p;
        }
        if let Some(c) = completion {
            let id = self.next_id();
            request["id"] = json!(id);
            self.completions.insert(id, c);
        }
        let _ = self.out.send(request.to_string());
    }

    /// Fire-and-forget notification (no completion).
    pub fn send_notification(&mut self, method: &str, params: Option<Value>) {
        self.send_remote_request(method, params, None);
    }
}

/// JS-truthiness for serde_json::Value (used by makeResponse / response routing).
pub fn is_truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().map(|f| f != 0.0).unwrap_or(true),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) => true,
        Value::Object(_) => true,
    }
}
