use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::HeaderMap;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{middleware, Extension, Json, Router};
use base64::Engine as _;
use futures_util::{SinkExt, StreamExt};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::mpsc;
use uuid::Uuid;

use super::auth::{auth_middleware, extract_node_id, AuthNode};
use super::{nodes_share_project_or_contact, ServerState};

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
    pub project_id: Option<String>,
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

#[derive(Debug, Deserialize)]
struct MailboxPollReq {
    limit: Option<usize>,
    after: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
struct MailboxPollResp {
    entries: Vec<MailboxPollEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct MailboxPollEntry {
    #[serde(rename = "messageId")]
    message_id: String,
    from: String,
    blob: String,
    #[serde(rename = "projectId", skip_serializing_if = "Option::is_none")]
    project_id: Option<String>,
    timestamp: String,
}

#[derive(Debug, Deserialize)]
struct MailboxAckReq {
    #[serde(rename = "messageIds")]
    message_ids: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct DerpFrame {
    src: Option<String>,
    dst: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    durable: Option<bool>,
    #[serde(with = "base64_serde")]
    data: Vec<u8>,
}

fn maybe_delivery_event_frame(
    from_node_id: &str,
    request_bytes: &[u8],
    state: &str,
) -> Option<Message> {
    let parsed: serde_json::Value = serde_json::from_slice(request_bytes).ok()?;
    let request_id = parsed.get("requestId")?.as_str()?;
    let payload = serde_json::json!({
        "from": from_node_id,
        "messageType": "delivery_event",
        "payload": { "requestId": request_id, "state": state },
    });
    let frame = DerpFrame {
        src: Some(from_node_id.to_string()),
        dst: None,
        durable: None,
        data: serde_json::to_vec(&payload).ok()?,
    };
    Some(Message::Text(serde_json::to_string(&frame).ok()?))
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
        .route("/v1/mailbox/poll", post(poll_mailbox_v2))
        .route("/v1/mailbox/ack", post(ack_mailbox_v2))
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

    let mut db = state
        .open_connection()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let sender_node_id = auth.0;
    let target_node_id = req.target_node_id;
    let allowed = if let Some(project_id) = req
        .project_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        db.query_row(
            "SELECT 1 FROM server_members m1 \
             JOIN server_members m2 ON m1.project_id = m2.project_id \
             WHERE m1.project_id = ?1 AND m1.node_id = ?2 AND m2.node_id = ?3 LIMIT 1",
            params![project_id, &sender_node_id, &target_node_id],
            |_| Ok(()),
        )
        .is_ok()
    } else {
        nodes_share_project_or_contact(&db, &sender_node_id, &target_node_id)
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    };
    if !allowed {
        return Err(StatusCode::FORBIDDEN);
    }

    let entry = MailboxEntry {
        from: sender_node_id,
        blob: req.blob,
        project_id: None,
        timestamp: chrono::Utc::now().to_rfc3339(),
    };

    let delivered = enqueue_mailbox_entry(&mut db, &target_node_id, &entry)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if !delivered {
        return Err(StatusCode::TOO_MANY_REQUESTS);
    }

    Ok(Json(RelayResp {
        delivered: true,
        message: format!("queued for {}", target_node_id),
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

/// Non-destructively poll pending encrypted messages for this node.
/// Messages remain in the mailbox until explicitly acknowledged through
/// `/v1/mailbox/ack`, allowing clients to persist them locally before acking.
async fn poll_mailbox_v2(
    State(state): State<Arc<ServerState>>,
    Extension(auth): Extension<AuthNode>,
    Json(req): Json<MailboxPollReq>,
) -> Result<Json<MailboxPollResp>, StatusCode> {
    let db = state
        .open_connection()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let entries = poll_mailbox_entries(&db, &auth.0, req.after.as_deref(), req.limit)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(MailboxPollResp { entries }))
}

/// Acknowledge previously polled mailbox messages after local durable persistence.
async fn ack_mailbox_v2(
    State(state): State<Arc<ServerState>>,
    Extension(auth): Extension<AuthNode>,
    Json(req): Json<MailboxAckReq>,
) -> Result<StatusCode, StatusCode> {
    let mut db = state
        .open_connection()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    ack_mailbox_entries(&mut db, &auth.0, &req.message_ids)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(StatusCode::NO_CONTENT)
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
                let durable = frame.durable.unwrap_or(true);
                let request_bytes = frame.data.clone();
                let mut db = match state.open_connection() {
                    Ok(db) => db,
                    Err(err) => {
                        eprintln!("DERP database open error for {}: {}", dst_node_id, err);
                        if let Some(ack) =
                            maybe_delivery_event_frame(&dst_node_id, &request_bytes, "failed")
                        {
                            let _ = tx.send(ack);
                        }
                        continue;
                    }
                };
                let allowed = match nodes_share_project_or_contact(&db, &node_id, &dst_node_id) {
                    Ok(allowed) => allowed,
                    Err(err) => {
                        eprintln!(
                            "DERP authorization lookup error for {}: {}",
                            dst_node_id, err
                        );
                        false
                    }
                };
                if !allowed {
                    if let Some(ack) =
                        maybe_delivery_event_frame(&dst_node_id, &request_bytes, "failed")
                    {
                        let _ = tx.send(ack);
                    }
                    continue;
                }
                if durable {
                    let entry = MailboxEntry {
                        from: node_id.clone(),
                        blob: base64::engine::general_purpose::STANDARD.encode(&request_bytes),
                        project_id: None,
                        timestamp: chrono::Utc::now().to_rfc3339(),
                    };
                    match enqueue_mailbox_entry(&mut db, &dst_node_id, &entry) {
                        Ok(true) => {}
                        Ok(false) => {
                            if let Some(ack) =
                                maybe_delivery_event_frame(&dst_node_id, &request_bytes, "failed")
                            {
                                let _ = tx.send(ack);
                            }
                            continue;
                        }
                        Err(err) => {
                            eprintln!("DERP mailbox enqueue error for {}: {}", dst_node_id, err);
                            if let Some(ack) =
                                maybe_delivery_event_frame(&dst_node_id, &request_bytes, "failed")
                            {
                                let _ = tx.send(ack);
                            }
                            continue;
                        }
                    }
                }

                let outbound = DerpFrame {
                    src: Some(node_id.clone()),
                    dst: None,
                    durable: None,
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

fn poll_mailbox_entries(
    conn: &Connection,
    target_node_id: &str,
    after_message_id: Option<&str>,
    limit: Option<usize>,
) -> Result<Vec<MailboxPollEntry>, rusqlite::Error> {
    let limit = limit
        .unwrap_or(MAX_MAILBOX_PER_NODE)
        .min(MAX_MAILBOX_PER_NODE) as i64;
    let cursor = after_message_id
        .map(|message_id| {
            conn.query_row(
                "SELECT created_at FROM server_mailbox WHERE target_node_id = ?1 AND message_id = ?2",
                params![target_node_id, message_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
        })
        .transpose()?
        .flatten();

    let mut stmt = conn.prepare(
        "SELECT message_id, from_node_id, blob, project_id, created_at \
         FROM server_mailbox \
         WHERE target_node_id = ?1 \
           AND (?2 IS NULL OR created_at > ?2 OR (created_at = ?2 AND message_id > ?3)) \
         ORDER BY created_at ASC, message_id ASC \
         LIMIT ?4",
    )?;
    let rows = stmt.query_map(
        params![target_node_id, cursor.as_deref(), after_message_id, limit],
        |row| {
            Ok(MailboxPollEntry {
                message_id: row.get(0)?,
                from: row.get(1)?,
                blob: row.get(2)?,
                project_id: row.get(3)?,
                timestamp: row.get(4)?,
            })
        },
    )?;

    let mut entries = Vec::new();
    for row in rows {
        entries.push(row?);
    }
    Ok(entries)
}

fn ack_mailbox_entries(
    conn: &mut Connection,
    target_node_id: &str,
    message_ids: &[String],
) -> Result<usize, rusqlite::Error> {
    if message_ids.is_empty() {
        return Ok(0);
    }

    let tx = conn.transaction()?;
    let mut acked = 0;
    for message_id in message_ids {
        acked += tx.execute(
            "DELETE FROM server_mailbox WHERE target_node_id = ?1 AND message_id = ?2",
            params![target_node_id, message_id],
        )?;
    }
    tx.commit()?;
    Ok(acked)
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
    use sha2::{Digest, Sha256};
    use std::path::{Path, PathBuf};
    use tokio_tungstenite::connect_async;
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    use tokio_tungstenite::tungstenite::Message as TungsteniteMessage;

    fn test_db_path() -> PathBuf {
        std::env::temp_dir().join(format!("bridges-relay-test-{}.db", Uuid::new_v4()))
    }

    fn test_state_for_path(db_path: &Path) -> Arc<ServerState> {
        let conn = Connection::open(db_path).unwrap();
        super::super::init_server_db(&conn).unwrap();
        drop(conn);
        Arc::new(ServerState::new(db_path.to_path_buf()))
    }

    fn seed_mailbox_entry(state: &ServerState, from: &str, to: &str, blob: &str) {
        let mut conn = state.open_connection().unwrap();
        let entry = MailboxEntry {
            from: from.to_string(),
            blob: blob.to_string(),
            project_id: None,
            timestamp: chrono::Utc::now().to_rfc3339(),
        };
        assert!(enqueue_mailbox_entry(&mut conn, to, &entry).unwrap());
    }

    fn seed_contact(state: &ServerState, left: &str, right: &str) {
        let conn = state.open_connection().unwrap();
        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "INSERT OR IGNORE INTO server_contacts (node_id, contact_node_id, created_at) VALUES (?1, ?2, ?3)",
            rusqlite::params![left, right, &now],
        )
        .unwrap();
        conn.execute(
            "INSERT OR IGNORE INTO server_contacts (node_id, contact_node_id, created_at) VALUES (?1, ?2, ?3)",
            rusqlite::params![right, left, now],
        )
        .unwrap();
    }

    fn seed_project_members(state: &ServerState, project_id: &str, node_ids: &[&str]) {
        let conn = state.open_connection().unwrap();
        let now = chrono::Utc::now().to_rfc3339();
        for node_id in node_ids {
            conn.execute(
                "INSERT OR IGNORE INTO server_members (project_id, node_id, agent_role, joined_at) VALUES (?1, ?2, 'member', ?3)",
                rusqlite::params![project_id, node_id, &now],
            )
            .unwrap();
        }
    }

    fn seed_registered_node(state: &ServerState, node_id: &str, api_key: &str) {
        let conn = state.open_connection().unwrap();
        let mut hash = Sha256::new();
        hash.update(api_key.as_bytes());
        let api_key_hash = hex::encode(hash.finalize());
        conn.execute(
            "INSERT OR IGNORE INTO registered_nodes (node_id, ed25519_pubkey, x25519_pubkey, display_name, owner_name, api_key_hash, created_at) VALUES (?1, 'ed25519', 'x25519', ?1, ?1, ?2, ?3)",
            rusqlite::params![node_id, api_key_hash, chrono::Utc::now().to_rfc3339()],
        )
        .unwrap();
    }

    async fn connect_test_derp_client(
        base_url: &str,
        api_key: &str,
    ) -> tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>
    {
        let mut request = format!("{base_url}/ws/derp").into_client_request().unwrap();
        request.headers_mut().insert(
            "Authorization",
            format!("Bearer {api_key}").parse().unwrap(),
        );
        let (socket, _) = connect_async(request).await.unwrap();
        socket
    }

    #[tokio::test]
    async fn derp_realtime_message_is_mailboxed_until_receiver_acks() {
        let db_path = test_db_path();
        let state = test_state_for_path(&db_path);
        seed_registered_node(&state, "sender", "sender-key");
        seed_registered_node(&state, "receiver", "receiver-key");
        seed_contact(&state, "sender", "receiver");

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server_state = state.clone();
        tokio::spawn(async move {
            axum::serve(listener, routes(server_state)).await.unwrap();
        });
        let base_url = format!("ws://{addr}");

        let _receiver_socket = connect_test_derp_client(&base_url, "receiver-key").await;
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        let mut sender_socket = connect_test_derp_client(&base_url, "sender-key").await;
        let payload = serde_json::json!({
            "requestId": "bridge_req_ws_durable_1",
            "messageType": "raw",
            "payload": { "message": "durable websocket message" },
        });
        let frame = DerpFrame {
            src: None,
            dst: Some("receiver".to_string()),
            durable: Some(true),
            data: serde_json::to_vec(&payload).unwrap(),
        };
        sender_socket
            .send(TungsteniteMessage::Text(
                serde_json::to_string(&frame).unwrap(),
            ))
            .await
            .unwrap();

        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        let pending = poll_mailbox_v2(
            State(state.clone()),
            Extension(AuthNode("receiver".to_string())),
            Json(MailboxPollReq {
                limit: Some(100),
                after: None,
            }),
        )
        .await
        .expect("poll mailbox")
        .0;
        assert_eq!(pending.entries.len(), 1);
        assert_eq!(pending.entries[0].from, "sender");

        let ack_ids = pending
            .entries
            .iter()
            .map(|entry| entry.message_id.clone())
            .collect::<Vec<_>>();
        ack_mailbox_v2(
            State(state.clone()),
            Extension(AuthNode("receiver".to_string())),
            Json(MailboxAckReq {
                message_ids: ack_ids,
            }),
        )
        .await
        .expect("ack mailbox");

        let after_ack = poll_mailbox_v2(
            State(state),
            Extension(AuthNode("receiver".to_string())),
            Json(MailboxPollReq {
                limit: Some(100),
                after: None,
            }),
        )
        .await
        .expect("poll after ack")
        .0;
        assert!(after_ack.entries.is_empty());
    }

    #[tokio::test]
    async fn derp_realtime_message_requires_contact_or_project_before_mailbox() {
        let db_path = test_db_path();
        let state = test_state_for_path(&db_path);
        seed_registered_node(&state, "sender", "sender-key");
        seed_registered_node(&state, "receiver", "receiver-key");

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server_state = state.clone();
        tokio::spawn(async move {
            axum::serve(listener, routes(server_state)).await.unwrap();
        });
        let base_url = format!("ws://{addr}");

        let _receiver_socket = connect_test_derp_client(&base_url, "receiver-key").await;
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        let mut sender_socket = connect_test_derp_client(&base_url, "sender-key").await;
        let frame = DerpFrame {
            src: None,
            dst: Some("receiver".to_string()),
            durable: Some(true),
            data: serde_json::to_vec(&serde_json::json!({
                "requestId": "bridge_req_ws_unauthorized",
                "messageType": "raw",
                "payload": { "message": "should not mailbox" },
            }))
            .unwrap(),
        };
        sender_socket
            .send(TungsteniteMessage::Text(
                serde_json::to_string(&frame).unwrap(),
            ))
            .await
            .unwrap();

        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        let pending = poll_mailbox_v2(
            State(state),
            Extension(AuthNode("receiver".to_string())),
            Json(MailboxPollReq {
                limit: Some(100),
                after: None,
            }),
        )
        .await
        .expect("poll mailbox")
        .0;
        assert!(pending.entries.is_empty());
    }

    #[tokio::test]
    async fn mailbox_poll_requires_ack_before_removal() {
        let db_path = test_db_path();
        let state = test_state_for_path(&db_path);
        seed_mailbox_entry(&state, "sender", "receiver", "blob-1");
        seed_mailbox_entry(&state, "sender", "receiver", "blob-2");

        let first = poll_mailbox_v2(
            State(state.clone()),
            Extension(AuthNode("receiver".to_string())),
            Json(MailboxPollReq {
                limit: Some(100),
                after: None,
            }),
        )
        .await
        .expect("poll mailbox")
        .0;
        assert_eq!(first.entries.len(), 2);

        let second = poll_mailbox_v2(
            State(state.clone()),
            Extension(AuthNode("receiver".to_string())),
            Json(MailboxPollReq {
                limit: Some(100),
                after: None,
            }),
        )
        .await
        .expect("poll mailbox again")
        .0;
        assert_eq!(second.entries.len(), 2, "poll must not destructively drain");

        let ack_ids = first
            .entries
            .iter()
            .map(|entry| entry.message_id.clone())
            .collect();
        ack_mailbox_v2(
            State(state.clone()),
            Extension(AuthNode("receiver".to_string())),
            Json(MailboxAckReq {
                message_ids: ack_ids,
            }),
        )
        .await
        .expect("ack mailbox");

        let after_ack = poll_mailbox_v2(
            State(state),
            Extension(AuthNode("receiver".to_string())),
            Json(MailboxPollReq {
                limit: Some(100),
                after: None,
            }),
        )
        .await
        .expect("poll after ack")
        .0;
        assert_eq!(after_ack.entries.len(), 0);
    }

    #[tokio::test]
    async fn mailbox_poll_after_acked_cursor_returns_remaining_entries() {
        let db_path = test_db_path();
        let state = test_state_for_path(&db_path);
        seed_mailbox_entry(&state, "sender", "receiver", "blob-1");
        seed_mailbox_entry(&state, "sender", "receiver", "blob-2");

        let first_page = poll_mailbox_v2(
            State(state.clone()),
            Extension(AuthNode("receiver".to_string())),
            Json(MailboxPollReq {
                limit: Some(1),
                after: None,
            }),
        )
        .await
        .expect("poll first page")
        .0;
        assert_eq!(first_page.entries.len(), 1);
        let first_message_id = first_page.entries[0].message_id.clone();

        ack_mailbox_v2(
            State(state.clone()),
            Extension(AuthNode("receiver".to_string())),
            Json(MailboxAckReq {
                message_ids: vec![first_message_id.clone()],
            }),
        )
        .await
        .expect("ack first message");

        let remaining = poll_mailbox_v2(
            State(state),
            Extension(AuthNode("receiver".to_string())),
            Json(MailboxPollReq {
                limit: Some(100),
                after: Some(first_message_id),
            }),
        )
        .await
        .expect("poll after acked cursor")
        .0;
        assert_eq!(remaining.entries.len(), 1);
        assert_eq!(remaining.entries[0].blob, "blob-2");
    }

    #[tokio::test]
    async fn mailbox_survives_state_restart_until_fetched() {
        let db_path = test_db_path();
        let state = test_state_for_path(&db_path);
        seed_project_members(&state, "proj_1", &["sender", "receiver"]);

        let _ = relay_message(
            State(state.clone()),
            Extension(AuthNode("sender".to_string())),
            Json(RelayReq {
                target_node_id: "receiver".to_string(),
                blob: "hello".to_string(),
                project_id: Some("proj_1".to_string()),
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
        seed_contact(&state, "sender", "receiver");

        for blob in ["one", "two"] {
            let _ = relay_message(
                State(state.clone()),
                Extension(AuthNode("sender".to_string())),
                Json(RelayReq {
                    target_node_id: "receiver".to_string(),
                    blob: blob.to_string(),
                    project_id: None,
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
