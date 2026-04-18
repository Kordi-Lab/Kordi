use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::HeaderMap;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{middleware, Extension, Json, Router};
use futures_util::{SinkExt, StreamExt};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::mpsc;
use uuid::Uuid;

use super::auth::{auth_middleware, extract_node_id, AuthNode};
use super::ServerState;

/// Relay request: opaque message blob only.
/// For mailbox/direct relay, the server routes the blob without understanding its body.
#[derive(Deserialize)]
pub struct RelayReq {
    /// Target node to deliver the blob to.
    #[serde(rename = "targetNodeId")]
    pub target_node_id: String,
    /// Opaque message blob. For mailbox relay this is an encrypted envelope string.
    pub blob: String,
    /// Optional project ID for authorization-aware decrypt/key lookup on clients.
    #[serde(rename = "projectId")]
    pub _project_id: Option<String>,
}

#[derive(Serialize)]
pub struct RelayResp {
    pub delivered: bool,
    pub message: String,
}

/// Broadcast request: sends an opaque encrypted blob to all project members.
/// Each member gets their own copy (sender must encrypt per-peer).
#[derive(Deserialize)]
pub struct BroadcastReq {
    #[serde(rename = "projectId")]
    pub project_id: String,
    /// Map of node_id -> base64-encoded encrypted blob (per-peer encryption).
    pub blobs: std::collections::HashMap<String, String>,
}

#[derive(Serialize)]
pub struct BroadcastResp {
    pub sent_to: Vec<String>,
}

/// Mailbox entry: stores opaque message blobs for later pickup.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct MailboxEntry {
    from: String,
    blob: String,
    #[serde(rename = "projectId", skip_serializing_if = "Option::is_none")]
    project_id: Option<String>,
    timestamp: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct DerpFrame {
    src: Option<String>,
    dst: Option<String>,
    #[serde(with = "base64_serde")]
    data: Vec<u8>,
}

mod base64_serde {
    use base64::Engine;
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(data: &[u8], s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&base64::engine::general_purpose::STANDARD.encode(data))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<u8>, D::Error> {
        let s = String::deserialize(d)?;
        base64::engine::general_purpose::STANDARD
            .decode(&s)
            .map_err(serde::de::Error::custom)
    }
}

pub fn routes(state: Arc<ServerState>) -> Router {
    Router::new()
        .route("/v1/relay", post(relay_message))
        .route("/v1/broadcast", post(broadcast_message))
        .route("/v1/mailbox", post(fetch_mailbox))
        .route("/ws/derp", get(derp_ws))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            auth_middleware,
        ))
        .with_state(state)
}

/// Max messages per node in the mailbox.
/// Mailbox entries are now persisted in SQLite, so this remains a durable queue bound.
const MAX_MAILBOX_PER_NODE: usize = 1000;
/// Max blob size (64 KB).
const MAX_BLOB_SIZE: usize = 65536;

/// Relay a single opaque blob to a target node.
/// End-to-end confidentiality depends on the sender encrypting the blob body.
async fn relay_message(
    State(state): State<Arc<ServerState>>,
    Extension(auth): Extension<AuthNode>,
    Json(req): Json<RelayReq>,
) -> Result<Json<RelayResp>, StatusCode> {
    if req.blob.len() > MAX_BLOB_SIZE {
        return Err(StatusCode::PAYLOAD_TOO_LARGE);
    }

    let entry = MailboxEntry {
        from: auth.0,
        blob: req.blob,
        project_id: None,
        timestamp: chrono::Utc::now().to_rfc3339(),
    };

    let mut db = state
        .open_connection()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let delivered = enqueue_mailbox_entry(&mut db, &req.target_node_id, &entry)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if !delivered {
        return Err(StatusCode::TOO_MANY_REQUESTS);
    }

    Ok(Json(RelayResp {
        delivered: true,
        message: format!("queued for {}", req.target_node_id),
    }))
}

/// Broadcast per-peer message blobs to all specified project members.
/// The sender is responsible for encrypting per-peer blob bodies.
async fn broadcast_message(
    State(state): State<Arc<ServerState>>,
    Extension(auth): Extension<AuthNode>,
    Json(req): Json<BroadcastReq>,
) -> Result<Json<BroadcastResp>, StatusCode> {
    let is_member: bool = {
        let db = state
            .open_connection()
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        let mut stmt = db
            .prepare("SELECT 1 FROM server_members WHERE project_id = ?1 AND node_id = ?2")
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        stmt.exists(params![req.project_id, auth.0])
            .unwrap_or(false)
    };
    if !is_member {
        return Err(StatusCode::FORBIDDEN);
    }

    for blob in req.blobs.values() {
        if blob.len() > MAX_BLOB_SIZE {
            return Err(StatusCode::PAYLOAD_TOO_LARGE);
        }
    }

    let mut db = state
        .open_connection()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let sent_to = enqueue_broadcast_entries(&mut db, &auth.0, &req)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(BroadcastResp { sent_to }))
}

/// Fetch and atomically drain pending encrypted messages for this node.
/// Delivery semantics: queued mailbox entries survive process restarts until fetched,
/// and a successful fetch removes exactly the messages returned in that response.
/// To minimize coordination-visible metadata, mailbox entries do not retain project IDs.
async fn fetch_mailbox(
    State(state): State<Arc<ServerState>>,
    Extension(auth): Extension<AuthNode>,
) -> Result<Json<Vec<MailboxEntry>>, StatusCode> {
    let mut db = state
        .open_connection()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let messages =
        drain_mailbox_entries(&mut db, &auth.0).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(messages))
}

async fn derp_ws(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Result<impl IntoResponse, StatusCode> {
    let node_id = extract_node_id(&state, &headers)
        .await
        .ok_or(StatusCode::UNAUTHORIZED)?;
    Ok(ws.on_upgrade(move |socket| handle_derp_socket(state, node_id, socket)))
}

async fn handle_derp_socket(state: Arc<ServerState>, node_id: String, socket: WebSocket) {
    let (mut ws_sender, mut ws_receiver) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();

    {
        let mut clients = state.derp_clients.lock().await;
        clients.insert(node_id.clone(), tx.clone());
    }

    let send_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if ws_sender.send(msg).await.is_err() {
                break;
            }
        }
    });

    while let Some(Ok(msg)) = ws_receiver.next().await {
        match msg {
            Message::Text(text) => {
                let frame: DerpFrame = match serde_json::from_str(&text) {
                    Ok(frame) => frame,
                    Err(err) => {
                        eprintln!("DERP parse error from {}: {}", node_id, err);
                        continue;
                    }
                };
                let Some(dst_node_id) = frame.dst else {
                    continue;
                };
                let outbound = DerpFrame {
                    src: Some(node_id.clone()),
                    dst: None,
                    data: frame.data,
                };
                let json = match serde_json::to_string(&outbound) {
                    Ok(json) => json,
                    Err(err) => {
                        eprintln!("DERP serialize error for {}: {}", dst_node_id, err);
                        continue;
                    }
                };

                let peer_tx = {
                    let clients = state.derp_clients.lock().await;
                    clients.get(&dst_node_id).cloned()
                };
                if let Some(peer_tx) = peer_tx {
                    let _ = peer_tx.send(Message::Text(json));
                }
            }
            Message::Ping(payload) => {
                let _ = tx.send(Message::Pong(payload));
            }
            Message::Close(_) => break,
            Message::Pong(_) | Message::Binary(_) => {}
        }
    }

    {
        let mut clients = state.derp_clients.lock().await;
        clients.remove(&node_id);
    }
    send_task.abort();
}

fn enqueue_mailbox_entry(
    conn: &mut Connection,
    target_node_id: &str,
    entry: &MailboxEntry,
) -> Result<bool, rusqlite::Error> {
    let tx = conn.transaction()?;
    let queue_len: i64 = tx.query_row(
        "SELECT COUNT(*) FROM server_mailbox WHERE target_node_id = ?1",
        params![target_node_id],
        |row| row.get(0),
    )?;
    if queue_len >= MAX_MAILBOX_PER_NODE as i64 {
        return Ok(false);
    }

    tx.execute(
        "INSERT INTO server_mailbox (message_id, target_node_id, from_node_id, blob, project_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            Uuid::new_v4().to_string(),
            target_node_id,
            entry.from,
            entry.blob,
            entry.project_id,
            entry.timestamp,
        ],
    )?;
    tx.commit()?;
    Ok(true)
}

fn enqueue_broadcast_entries(
    conn: &mut Connection,
    from_node_id: &str,
    req: &BroadcastReq,
) -> Result<Vec<String>, rusqlite::Error> {
    let tx = conn.transaction()?;
    let mut sent_to = Vec::new();

    for (node_id, blob) in &req.blobs {
        if node_id == from_node_id {
            continue;
        }

        let queue_len: i64 = tx.query_row(
            "SELECT COUNT(*) FROM server_mailbox WHERE target_node_id = ?1",
            params![node_id],
            |row| row.get(0),
        )?;
        if queue_len >= MAX_MAILBOX_PER_NODE as i64 {
            continue;
        }

        tx.execute(
            "INSERT INTO server_mailbox (message_id, target_node_id, from_node_id, blob, project_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                Uuid::new_v4().to_string(),
                node_id,
                from_node_id,
                blob,
                Option::<String>::None,
                chrono::Utc::now().to_rfc3339(),
            ],
        )?;
        sent_to.push(node_id.clone());
    }

    tx.commit()?;
    Ok(sent_to)
}

fn drain_mailbox_entries(
    conn: &mut Connection,
    target_node_id: &str,
) -> Result<Vec<MailboxEntry>, rusqlite::Error> {
    let tx = conn.transaction()?;
    let drained = {
        let mut stmt = tx.prepare(
            "SELECT message_id, from_node_id, blob, project_id, created_at \
             FROM server_mailbox WHERE target_node_id = ?1 \
             ORDER BY created_at ASC, message_id ASC",
        )?;
        let rows = stmt.query_map(params![target_node_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                MailboxEntry {
                    from: row.get(1)?,
                    blob: row.get(2)?,
                    project_id: row.get(3)?,
                    timestamp: row.get(4)?,
                },
            ))
        })?;

        let mut drained = Vec::new();
        for row in rows {
            drained.push(row?);
        }
        drained
    };

    for (message_id, _) in &drained {
        tx.execute(
            "DELETE FROM server_mailbox WHERE message_id = ?1",
            params![message_id],
        )?;
    }

    tx.commit()?;
    Ok(drained.into_iter().map(|(_, entry)| entry).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    fn test_db_path() -> PathBuf {
        std::env::temp_dir().join(format!("bridges-relay-test-{}.db", Uuid::new_v4()))
    }

    fn test_state_for_path(db_path: &Path) -> Arc<ServerState> {
        let conn = Connection::open(db_path).unwrap();
        super::super::init_server_db(&conn).unwrap();
        drop(conn);
        Arc::new(ServerState::new(db_path.to_path_buf()))
    }

    #[tokio::test]
    async fn mailbox_survives_state_restart_until_fetched() {
        let db_path = test_db_path();
        let state = test_state_for_path(&db_path);

        let _ = relay_message(
            State(state.clone()),
            Extension(AuthNode("sender".to_string())),
            Json(RelayReq {
                target_node_id: "receiver".to_string(),
                blob: "hello".to_string(),
                _project_id: Some("proj_1".to_string()),
            }),
        )
        .await
        .unwrap();

        let restarted_state = Arc::new(ServerState::new(db_path.clone()));
        let messages = fetch_mailbox(
            State(restarted_state),
            Extension(AuthNode("receiver".to_string())),
        )
        .await
        .unwrap()
        .0;

        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].from, "sender");
        assert_eq!(messages[0].blob, "hello");
        assert_eq!(messages[0].project_id, None);
    }

    #[tokio::test]
    async fn mailbox_fetch_drains_only_once() {
        let db_path = test_db_path();
        let state = test_state_for_path(&db_path);

        for blob in ["one", "two"] {
            let _ = relay_message(
                State(state.clone()),
                Extension(AuthNode("sender".to_string())),
                Json(RelayReq {
                    target_node_id: "receiver".to_string(),
                    blob: blob.to_string(),
                    _project_id: None,
                }),
            )
            .await
            .unwrap();
        }

        let first = fetch_mailbox(
            State(state.clone()),
            Extension(AuthNode("receiver".to_string())),
        )
        .await
        .unwrap()
        .0;
        let second = fetch_mailbox(State(state), Extension(AuthNode("receiver".to_string())))
            .await
            .unwrap()
            .0;

        assert_eq!(first.len(), 2);
        assert!(second.is_empty());
        assert_eq!(first[0].blob, "one");
        assert_eq!(first[1].blob, "two");
    }
}
