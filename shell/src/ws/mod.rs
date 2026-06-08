//! WebSocket upgrade + dispatch. Port of the `connection` routing in `index.js`.

pub mod serialport_session;
pub mod session;

use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc::unbounded_channel;

use crate::ws::serialport_session::SerialportSession;
use crate::AppState;

/// Legacy WS routes that map to the serialport session.
pub const SERIALPORT_ROUTES: [&str; 4] = [
    "/openblock/serialport",
    "/winblock/serialport",
    "/windy/serial",
    "/windy/serialport",
];

/// Axum handler: upgrade any path, but only accept the serialport routes; reject
/// (immediately close) everything else — mirrors `socket.close()` in index.js.
pub async fn ws_handler(
    ws: WebSocketUpgrade,
    State(app): State<Arc<AppState>>,
    axum::extract::OriginalUri(uri): axum::extract::OriginalUri,
) -> impl IntoResponse {
    let path = uri.path().to_string();
    if !SERIALPORT_ROUTES.contains(&path.as_str()) {
        tracing::warn!("[link] reject websocket: unsupported path={}", path);
        // Still upgrade, then immediately close (so the client sees a clean close).
        return ws
            .on_upgrade(|socket| async move {
                let _ = socket.close().await;
            })
            .into_response();
    }

    app.inc_connection();
    tracing::info!("[link] new connection: path={}", path);
    let app2 = app.clone();
    ws.on_upgrade(move |socket| handle_socket(socket, app2)).into_response()
}

async fn handle_socket(socket: WebSocket, app: Arc<AppState>) {
    let (mut ws_sink, mut ws_stream) = socket.split();

    // Outbound channel: session → websocket writer.
    let (out_tx, mut out_rx) = unbounded_channel::<String>();
    // Inbound channel: websocket reader → session actor.
    let (in_tx, in_rx) = unbounded_channel::<String>();

    let user_data = app.user_data_path.clone();
    let tools = app.tools_path.clone();
    let app_for_session = app.clone();

    // Writer task: drains the outbound channel to the socket.
    let writer = tokio::spawn(async move {
        while let Some(text) = out_rx.recv().await {
            if ws_sink.send(Message::Text(text)).await.is_err() {
                break;
            }
        }
    });

    // Session actor task.
    let session = SerialportSession::new(out_tx, user_data, tools, app_for_session);
    let actor = tokio::spawn(session.run(in_rx));

    // Reader loop: forward inbound text frames to the actor.
    while let Some(Ok(msg)) = ws_stream.next().await {
        match msg {
            Message::Text(text) => {
                if in_tx.send(text).is_err() {
                    break;
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    // Dropping in_tx closes the actor's ws_rx → actor disposes itself.
    drop(in_tx);
    let _ = actor.await;
    writer.abort();
}

/// 404 fallback for non-WS unmatched requests handled in server.rs; kept here for
/// symmetry if axum routing needs an explicit reject status.
#[allow(dead_code)]
pub fn rejected() -> StatusCode {
    StatusCode::NOT_FOUND
}
