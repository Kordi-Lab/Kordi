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
use super::{nodes_can_directly_reach, DirectAccessKind, ServerState};

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
    /// Optional direct-access intent for host/agent reachability policy.
    #[serde(rename = "targetKind", default)]
    pub target_kind: Option<String>,
    /// Optional client-side idempotency key. Repeating the same
    /// (targetNodeId, clientMessageId) pair returns the original message id
    /// instead of producing a second mailbox row.
    #[serde(rename = "clientMessageId", default)]
    pub client_message_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct RelayResp {
    pub delivered: bool,
    pub message: String,
    /// Server-side message id assigned to this send. When `clientMessageId`
    /// produces an idempotent retry, this is the id of the original send.
    #[serde(rename = "messageId", skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    /// Whether the request was a duplicate of an earlier send keyed by
    /// `clientMessageId`. Clients can use this to suppress local retry UI.
    #[serde(rename = "duplicate", default)]
    pub duplicate: bool,
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
    #[serde(
        rename = "targetKind",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    target_kind: Option<String>,
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
        target_kind: None,
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

/// How long an undelivered mailbox row may live before periodic GC reaps it.
/// Receivers that have been offline longer than this lose their queue, which
/// matches Telegram-style retention: users who don't return for a month
/// shouldn't pin server storage indefinitely.
pub const MAILBOX_RETENTION_DAYS: i64 = 30;
/// How often the periodic GC sweep runs.
pub const MAILBOX_GC_INTERVAL: std::time::Duration = std::time::Duration::from_secs(10 * 60);

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
        let access_kind = direct_access_kind_from_target_kind(req.target_kind.as_deref());
        nodes_can_directly_reach(&db, &sender_node_id, &target_node_id, access_kind)
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

    let outcome = enqueue_mailbox_entry(
        &mut db,
        &target_node_id,
        &entry,
        req.client_message_id.as_deref(),
    )
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    match outcome {
        EnqueueOutcome::QuotaExceeded => Err(StatusCode::TOO_MANY_REQUESTS),
        EnqueueOutcome::Inserted { message_id } => Ok(Json(RelayResp {
            delivered: true,
            message: format!("queued for {}", target_node_id),
            message_id: Some(message_id),
            duplicate: false,
        })),
        EnqueueOutcome::Duplicate { message_id } => Ok(Json(RelayResp {
            delivered: true,
            message: format!("duplicate of earlier send to {}", target_node_id),
            message_id: Some(message_id),
            duplicate: true,
        })),
    }
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
                let access_kind = frame
                    .target_kind
                    .as_deref()
                    .map(|target_kind| direct_access_kind_from_target_kind(Some(target_kind)))
                    .unwrap_or_else(|| direct_access_kind_from_payload_bytes(&request_bytes));
                let allowed =
                    match nodes_can_directly_reach(&db, &node_id, &dst_node_id, access_kind) {
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
                    match enqueue_mailbox_entry(&mut db, &dst_node_id, &entry, None) {
                        Ok(EnqueueOutcome::Inserted { .. }) | Ok(EnqueueOutcome::Duplicate { .. }) => {}
                        Ok(EnqueueOutcome::QuotaExceeded) => {
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
                    target_kind: None,
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

fn direct_access_kind_from_target_kind(target_kind: Option<&str>) -> DirectAccessKind {
    match target_kind
        .unwrap_or_default()
        .trim()
        .to_lowercase()
        .as_str()
    {
        "agent" | "bridge-agent" | "ask" => DirectAccessKind::Agent,
        "person-invite" | "bridge-person-invite" | "human-invite" | "session-invite" => {
            DirectAccessKind::GroupInvite
        }
        "session-participant" | "group-session" | "session-message" | "session-relay" => {
            DirectAccessKind::SessionParticipant
        }
        "person" | "bridge-person" | "human" => DirectAccessKind::Person,
        _ => DirectAccessKind::Any,
    }
}

fn direct_access_kind_from_payload_bytes(payload: &[u8]) -> DirectAccessKind {
    let parsed = serde_json::from_slice::<serde_json::Value>(payload).ok();
    let message_type = parsed
        .as_ref()
        .and_then(|value| value.get("messageType"))
        .and_then(|value| value.as_str());
    direct_access_kind_from_target_kind(message_type)
}

/// Result of an attempted mailbox enqueue. Idempotent retries that match an
/// earlier `(target_node_id, client_message_id)` pair return `Duplicate`
/// with the original `message_id` so the caller can echo it back verbatim.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EnqueueOutcome {
    /// Fresh row was inserted.
    Inserted { message_id: String },
    /// `client_message_id` matched an earlier row for this target; no new
    /// row was created.
    Duplicate { message_id: String },
    /// Per-target quota exceeded.
    QuotaExceeded,
}

fn enqueue_mailbox_entry(
    conn: &mut Connection,
    target_node_id: &str,
    entry: &MailboxEntry,
    client_message_id: Option<&str>,
) -> Result<EnqueueOutcome, rusqlite::Error> {
    let tx = conn.transaction()?;

    // Idempotency check first: if a row with the same client key already
    // exists for this target, return its message_id without consuming quota.
    if let Some(client_id) = client_message_id {
        let existing: Option<String> = tx
            .query_row(
                "SELECT message_id FROM server_mailbox \
                 WHERE target_node_id = ?1 AND client_message_id = ?2",
                params![target_node_id, client_id],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(message_id) = existing {
            tx.commit()?;
            return Ok(EnqueueOutcome::Duplicate { message_id });
        }
    }

    let queue_len: i64 = tx.query_row(
        "SELECT COUNT(*) FROM server_mailbox WHERE target_node_id = ?1",
        params![target_node_id],
        |row| row.get(0),
    )?;
    if queue_len >= MAX_MAILBOX_PER_NODE as i64 {
        return Ok(EnqueueOutcome::QuotaExceeded);
    }

    let new_id = Uuid::new_v4().to_string();
    tx.execute(
        "INSERT INTO server_mailbox (message_id, target_node_id, from_node_id, blob, project_id, created_at, client_message_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            new_id,
            target_node_id,
            entry.from,
            entry.blob,
            entry.project_id,
            entry.timestamp,
            client_message_id,
        ],
    )?;
    tx.commit()?;
    Ok(EnqueueOutcome::Inserted { message_id: new_id })
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

/// SQLite's default `SQLITE_MAX_VARIABLE_NUMBER` is 999 on older builds and
/// 32_766 on recent ones. 256 is comfortably below both and keeps each
/// `DELETE` statement small enough to plan and execute quickly.
const ACK_CHUNK_SIZE: usize = 256;

/// Delete mailbox rows older than `retention_days`, regardless of which
/// target they belong to. Targets that come back online after a long
/// absence lose their dead-letter queue rather than pinning storage forever.
/// Returns the number of rows deleted.
pub fn gc_mailbox_retention(
    conn: &Connection,
    retention_days: i64,
) -> Result<usize, rusqlite::Error> {
    let cutoff = (chrono::Utc::now() - chrono::Duration::days(retention_days.max(1))).to_rfc3339();
    conn.execute(
        "DELETE FROM server_mailbox WHERE created_at < ?1",
        params![cutoff],
    )
}

/// Delete the named mailbox entries for `target_node_id` using one chunked
/// `IN`-clause `DELETE` per 256 ids, instead of one statement per id. The
/// new `idx_server_mailbox_target_created_message` covering index lets the
/// planner satisfy these without a row visit.
fn ack_mailbox_entries(
    conn: &mut Connection,
    target_node_id: &str,
    message_ids: &[String],
) -> Result<usize, rusqlite::Error> {
    if message_ids.is_empty() {
        return Ok(0);
    }

    let tx = conn.transaction()?;
    let mut acked = 0usize;
    for chunk in message_ids.chunks(ACK_CHUNK_SIZE) {
        acked += delete_mailbox_chunk(&tx, target_node_id, chunk)?;
    }
    tx.commit()?;
    Ok(acked)
}

fn drain_mailbox_entries(
    conn: &mut Connection,
    target_node_id: &str,
) -> Result<Vec<MailboxEntry>, rusqlite::Error> {
    let tx = conn.transaction()?;
    let drained: Vec<(String, MailboxEntry)> = {
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

    if !drained.is_empty() {
        // Same chunking strategy as ack: one DELETE per 256 ids using the
        // covering mailbox index, instead of N statements.
        let ids: Vec<&str> = drained.iter().map(|(id, _)| id.as_str()).collect();
        for chunk in ids.chunks(ACK_CHUNK_SIZE) {
            // Convert the slice of &str into the format `delete_mailbox_chunk`
            // expects: a slice of String references via dyn ToSql.
            delete_mailbox_chunk_str(&tx, target_node_id, chunk)?;
        }
    }

    tx.commit()?;
    Ok(drained.into_iter().map(|(_, entry)| entry).collect())
}

fn delete_mailbox_chunk(
    tx: &rusqlite::Transaction<'_>,
    target_node_id: &str,
    chunk: &[String],
) -> Result<usize, rusqlite::Error> {
    let placeholders = build_chunk_placeholders(chunk.len());
    let sql = format!(
        "DELETE FROM server_mailbox WHERE target_node_id = ?1 AND message_id IN ({placeholders})"
    );
    let mut bound: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(chunk.len() + 1);
    bound.push(&target_node_id);
    for id in chunk {
        bound.push(id);
    }
    tx.execute(&sql, &bound[..])
}

fn delete_mailbox_chunk_str(
    tx: &rusqlite::Transaction<'_>,
    target_node_id: &str,
    chunk: &[&str],
) -> Result<usize, rusqlite::Error> {
    let placeholders = build_chunk_placeholders(chunk.len());
    let sql = format!(
        "DELETE FROM server_mailbox WHERE target_node_id = ?1 AND message_id IN ({placeholders})"
    );
    let mut bound: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(chunk.len() + 1);
    bound.push(&target_node_id);
    for id in chunk {
        bound.push(id);
    }
    tx.execute(&sql, &bound[..])
}

fn build_chunk_placeholders(count: usize) -> String {
    // Placeholders start at ?2 because ?1 is the target_node_id.
    let mut out = String::with_capacity(count * 5);
    for i in 0..count {
        if i > 0 {
            out.push_str(", ");
        }
        out.push('?');
        out.push_str(&(i + 2).to_string());
    }
    out
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
        let outcome = enqueue_mailbox_entry(&mut conn, to, &entry, None).unwrap();
        assert!(matches!(outcome, EnqueueOutcome::Inserted { .. }));
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
        seed_registered_node_with_policy(state, node_id, api_key, None, None, None, None, None);
    }

    fn seed_registered_node_with_policy(
        state: &ServerState,
        node_id: &str,
        api_key: &str,
        human_id: Option<&str>,
        agent_id: Option<&str>,
        human_visibility_policy: Option<&str>,
        contact_approval_policy: Option<&str>,
        agent_reachability_policy: Option<&str>,
    ) {
        let conn = state.open_connection().unwrap();
        let mut hash = Sha256::new();
        hash.update(api_key.as_bytes());
        let api_key_hash = hex::encode(hash.finalize());
        conn.execute(
            "INSERT OR IGNORE INTO registered_nodes (node_id, ed25519_pubkey, x25519_pubkey, display_name, owner_name, human_id, agent_id, api_key_hash, human_visibility_policy, contact_approval_policy, agent_reachability_policy, created_at) VALUES (?1, 'ed25519', 'x25519', ?1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![
                node_id,
                human_id,
                agent_id,
                api_key_hash,
                human_visibility_policy,
                contact_approval_policy,
                agent_reachability_policy,
                chrono::Utc::now().to_rfc3339(),
            ],
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
            target_kind: None,
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
            target_kind: None,
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
    async fn derp_group_invite_requires_contact_even_for_server_open_target() {
        let db_path = test_db_path();
        let state = test_state_for_path(&db_path);
        seed_registered_node(&state, "sender", "sender-key");
        seed_registered_node_with_policy(
            &state,
            "receiver",
            "receiver-key",
            Some("human-receiver"),
            None,
            Some("server-open"),
            Some("auto"),
            Some("contacts"),
        );

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
            target_kind: Some("person-invite".to_string()),
            data: serde_json::to_vec(&serde_json::json!({
                "requestId": "bridge_req_ws_group_invite",
                "messageType": "raw",
                "payload": { "message": "group invite" },
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
    async fn direct_relay_allows_server_open_target_without_contact() {
        let db_path = test_db_path();
        let state = test_state_for_path(&db_path);
        seed_registered_node(&state, "sender", "sender-key");
        seed_registered_node_with_policy(
            &state,
            "receiver",
            "receiver-key",
            Some("human-receiver"),
            None,
            Some("server-open"),
            Some("approval-required"),
            Some("contacts"),
        );

        let response = relay_message(
            State(state.clone()),
            Extension(AuthNode("sender".to_string())),
            Json(RelayReq {
                target_node_id: "receiver".to_string(),
                blob: "hello".to_string(),
                project_id: None,
                target_kind: Some("person".to_string()),
                client_message_id: None,
            }),
        )
        .await
        .unwrap()
        .0;

        assert!(response.delivered);
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
        assert_eq!(pending.entries.len(), 1);
        assert_eq!(pending.entries[0].from, "sender");
    }

    #[tokio::test]
    async fn direct_relay_blocks_approval_required_target_without_contact() {
        let db_path = test_db_path();
        let state = test_state_for_path(&db_path);
        seed_registered_node(&state, "sender", "sender-key");
        seed_registered_node_with_policy(
            &state,
            "receiver",
            "receiver-key",
            Some("human-receiver"),
            None,
            Some("server-approval"),
            Some("approval-required"),
            Some("contacts"),
        );

        let status = relay_message(
            State(state),
            Extension(AuthNode("sender".to_string())),
            Json(RelayReq {
                target_node_id: "receiver".to_string(),
                blob: "hello".to_string(),
                project_id: None,
                target_kind: Some("person".to_string()),
                client_message_id: None,
            }),
        )
        .await
        .unwrap_err();

        assert_eq!(status, StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn direct_relay_blocks_approval_required_target_when_only_shared_project() {
        let db_path = test_db_path();
        let state = test_state_for_path(&db_path);
        seed_registered_node(&state, "sender", "sender-key");
        seed_registered_node_with_policy(
            &state,
            "receiver",
            "receiver-key",
            Some("human-receiver"),
            None,
            Some("server-approval"),
            Some("approval-required"),
            Some("contacts"),
        );
        seed_project_members(&state, "project-1", &["sender", "receiver"]);

        let status = relay_message(
            State(state),
            Extension(AuthNode("sender".to_string())),
            Json(RelayReq {
                target_node_id: "receiver".to_string(),
                blob: "hello".to_string(),
                project_id: None,
                target_kind: Some("person".to_string()),
                client_message_id: None,
            }),
        )
        .await
        .unwrap_err();

        assert_eq!(status, StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn direct_relay_allows_session_participant_without_contact() {
        let db_path = test_db_path();
        let state = test_state_for_path(&db_path);
        seed_registered_node(&state, "sender", "sender-key");
        seed_registered_node_with_policy(
            &state,
            "receiver",
            "receiver-key",
            Some("human-receiver"),
            None,
            Some("server-approval"),
            Some("approval-required"),
            Some("contacts"),
        );

        let response = relay_message(
            State(state.clone()),
            Extension(AuthNode("sender".to_string())),
            Json(RelayReq {
                target_node_id: "receiver".to_string(),
                blob: "group session message".to_string(),
                project_id: None,
                target_kind: Some("session-participant".to_string()),
                client_message_id: None,
            }),
        )
        .await
        .unwrap()
        .0;

        assert!(response.delivered);
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
        assert_eq!(pending.entries.len(), 1);
        assert_eq!(pending.entries[0].blob, "group session message");
    }

    #[tokio::test]
    async fn direct_relay_blocks_group_invite_to_server_open_non_contact() {
        let db_path = test_db_path();
        let state = test_state_for_path(&db_path);
        seed_registered_node(&state, "sender", "sender-key");
        seed_registered_node_with_policy(
            &state,
            "receiver",
            "receiver-key",
            Some("human-receiver"),
            None,
            Some("server-open"),
            Some("auto"),
            Some("contacts"),
        );

        let status = relay_message(
            State(state),
            Extension(AuthNode("sender".to_string())),
            Json(RelayReq {
                target_node_id: "receiver".to_string(),
                blob: "invite".to_string(),
                project_id: None,
                target_kind: Some("person-invite".to_string()),
                client_message_id: None,
            }),
        )
        .await
        .unwrap_err();

        assert_eq!(status, StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn direct_relay_owner_agent_allows_same_human_and_blocks_other_humans() {
        let db_path = test_db_path();
        let state = test_state_for_path(&db_path);
        seed_registered_node_with_policy(
            &state,
            "owner-device",
            "owner-key",
            Some("human-owner"),
            None,
            Some("private"),
            Some("approval-required"),
            Some("contacts"),
        );
        seed_registered_node_with_policy(
            &state,
            "owner-agent",
            "agent-key",
            Some("human-owner"),
            Some("agent-owner"),
            Some("private"),
            Some("approval-required"),
            Some("owner"),
        );
        seed_registered_node_with_policy(
            &state,
            "stranger",
            "stranger-key",
            Some("human-stranger"),
            None,
            Some("private"),
            Some("approval-required"),
            Some("contacts"),
        );

        let accepted = relay_message(
            State(state.clone()),
            Extension(AuthNode("owner-device".to_string())),
            Json(RelayReq {
                target_node_id: "owner-agent".to_string(),
                blob: "ask".to_string(),
                project_id: None,
                target_kind: Some("agent".to_string()),
                client_message_id: None,
            }),
        )
        .await
        .expect("owner relay accepted")
        .0;
        assert!(accepted.delivered);

        let rejected = relay_message(
            State(state),
            Extension(AuthNode("stranger".to_string())),
            Json(RelayReq {
                target_node_id: "owner-agent".to_string(),
                blob: "ask".to_string(),
                project_id: None,
                target_kind: Some("agent".to_string()),
                client_message_id: None,
            }),
        )
        .await
        .unwrap_err();
        assert_eq!(rejected, StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn direct_relay_owner_agent_blocks_contacts_from_other_humans() {
        let db_path = test_db_path();
        let state = test_state_for_path(&db_path);
        seed_registered_node_with_policy(
            &state,
            "contact",
            "contact-key",
            Some("human-contact"),
            None,
            Some("private"),
            Some("approval-required"),
            Some("contacts"),
        );
        seed_registered_node_with_policy(
            &state,
            "owner-agent",
            "agent-key",
            Some("human-owner"),
            Some("agent-owner"),
            Some("private"),
            Some("approval-required"),
            Some("owner"),
        );
        seed_contact(&state, "contact", "owner-agent");

        let rejected = relay_message(
            State(state),
            Extension(AuthNode("contact".to_string())),
            Json(RelayReq {
                target_node_id: "owner-agent".to_string(),
                blob: "ask".to_string(),
                project_id: None,
                target_kind: Some("agent".to_string()),
                client_message_id: None,
            }),
        )
        .await
        .unwrap_err();
        assert_eq!(rejected, StatusCode::FORBIDDEN);
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
                target_kind: None,
                client_message_id: None,
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
        seed_registered_node(&state, "sender", "sender-key");
        seed_registered_node(&state, "receiver", "receiver-key");
        seed_contact(&state, "sender", "receiver");

        for blob in ["one", "two"] {
            let _ = relay_message(
                State(state.clone()),
                Extension(AuthNode("sender".to_string())),
                Json(RelayReq {
                    target_node_id: "receiver".to_string(),
                    blob: blob.to_string(),
                    project_id: None,
                    target_kind: None,
                client_message_id: None,
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

    #[test]
    fn enqueue_with_same_client_message_id_returns_original_message() {
        let db_path = test_db_path();
        let state = test_state_for_path(&db_path);
        let mut conn = state.open_connection().unwrap();
        let entry = MailboxEntry {
            from: "sender".to_string(),
            blob: "first-payload".to_string(),
            project_id: None,
            timestamp: chrono::Utc::now().to_rfc3339(),
        };
        let first =
            enqueue_mailbox_entry(&mut conn, "receiver", &entry, Some("client-key-1")).unwrap();
        let inserted_id = match first {
            EnqueueOutcome::Inserted { ref message_id } => message_id.clone(),
            _ => panic!("first send should produce a fresh row, got {first:?}"),
        };

        // Retry with the same key but a different blob — should NOT update or
        // duplicate; original row stays intact.
        let entry_retry = MailboxEntry {
            from: "sender".to_string(),
            blob: "second-payload".to_string(),
            project_id: None,
            timestamp: chrono::Utc::now().to_rfc3339(),
        };
        let second =
            enqueue_mailbox_entry(&mut conn, "receiver", &entry_retry, Some("client-key-1"))
                .unwrap();
        match second {
            EnqueueOutcome::Duplicate { ref message_id } => {
                assert_eq!(message_id, &inserted_id, "duplicate must echo original id");
            }
            _ => panic!("retry with same client_message_id must be Duplicate, got {second:?}"),
        }

        // Exactly one row remains and it carries the original payload.
        let rows: Vec<(String, String)> = conn
            .prepare("SELECT message_id, blob FROM server_mailbox WHERE target_node_id = 'receiver'")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].0, inserted_id);
        assert_eq!(rows[0].1, "first-payload");
    }

    #[test]
    fn enqueue_with_different_client_message_ids_produces_separate_rows() {
        let db_path = test_db_path();
        let state = test_state_for_path(&db_path);
        let mut conn = state.open_connection().unwrap();
        let make_entry = |blob: &str| MailboxEntry {
            from: "sender".to_string(),
            blob: blob.to_string(),
            project_id: None,
            timestamp: chrono::Utc::now().to_rfc3339(),
        };
        let first = enqueue_mailbox_entry(&mut conn, "receiver", &make_entry("a"), Some("k1"))
            .unwrap();
        let second = enqueue_mailbox_entry(&mut conn, "receiver", &make_entry("b"), Some("k2"))
            .unwrap();
        assert!(matches!(first, EnqueueOutcome::Inserted { .. }));
        assert!(matches!(second, EnqueueOutcome::Inserted { .. }));
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM server_mailbox WHERE target_node_id = 'receiver'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 2);
    }

    #[test]
    fn enqueue_without_client_message_id_does_not_dedupe() {
        // Legacy behaviour: clients that don't pass a key keep at-least-once
        // semantics. Two sends produce two rows even with identical payload.
        let db_path = test_db_path();
        let state = test_state_for_path(&db_path);
        let mut conn = state.open_connection().unwrap();
        let entry = MailboxEntry {
            from: "sender".to_string(),
            blob: "same-blob".to_string(),
            project_id: None,
            timestamp: chrono::Utc::now().to_rfc3339(),
        };
        enqueue_mailbox_entry(&mut conn, "receiver", &entry, None).unwrap();
        enqueue_mailbox_entry(&mut conn, "receiver", &entry, None).unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM server_mailbox WHERE target_node_id = 'receiver'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 2);
    }

    #[test]
    fn gc_mailbox_retention_only_prunes_rows_older_than_threshold() {
        let db_path = test_db_path();
        let state = test_state_for_path(&db_path);
        let conn = state.open_connection().unwrap();

        // Helper: insert a row with an explicit created_at timestamp.
        let insert_aged = |id: &str, days_old: i64| {
            let aged_at = (chrono::Utc::now() - chrono::Duration::days(days_old)).to_rfc3339();
            conn.execute(
                "INSERT INTO server_mailbox (message_id, target_node_id, from_node_id, blob, project_id, created_at) VALUES (?1, ?2, ?3, ?4, NULL, ?5)",
                params![id, "receiver", "sender", "blob", &aged_at],
            )
            .expect("insert aged row");
        };

        insert_aged("ancient-1", 60); // pruned
        insert_aged("old-1", 31); // pruned (just past 30 day boundary)
        insert_aged("recent-1", 29); // kept
        insert_aged("fresh-1", 0); // kept

        let pruned = gc_mailbox_retention(&conn, MAILBOX_RETENTION_DAYS).expect("gc");
        assert_eq!(pruned, 2, "only the two rows older than 30 days should be pruned");

        let remaining_ids: Vec<String> = conn
            .prepare("SELECT message_id FROM server_mailbox WHERE target_node_id = 'receiver' ORDER BY created_at")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .map(|row| row.unwrap())
            .collect();
        assert_eq!(remaining_ids, vec!["recent-1".to_string(), "fresh-1".to_string()]);
    }

    #[tokio::test]
    async fn ack_chunks_more_than_three_chunks_of_message_ids() {
        // Exercises the chunked IN-clause DELETE — well above ACK_CHUNK_SIZE
        // (256) so the code path runs three chunks. Stays under
        // MAX_MAILBOX_PER_NODE (1000) to keep enqueue acceptance.
        let db_path = test_db_path();
        let state = test_state_for_path(&db_path);
        let total = 768usize;
        for index in 0..total {
            seed_mailbox_entry(&state, "sender", "receiver", &format!("blob-{index}"));
        }

        let mut all_ids: Vec<String> = Vec::with_capacity(total);
        let mut after: Option<String> = None;
        loop {
            let page = poll_mailbox_v2(
                State(state.clone()),
                Extension(AuthNode("receiver".to_string())),
                Json(MailboxPollReq {
                    limit: Some(500),
                    after: after.clone(),
                }),
            )
            .await
            .expect("poll page")
            .0;
            if page.entries.is_empty() {
                break;
            }
            after = page.entries.last().map(|entry| entry.message_id.clone());
            all_ids.extend(page.entries.into_iter().map(|entry| entry.message_id));
        }
        assert_eq!(all_ids.len(), total);

        ack_mailbox_v2(
            State(state.clone()),
            Extension(AuthNode("receiver".to_string())),
            Json(MailboxAckReq { message_ids: all_ids }),
        )
        .await
        .expect("ack many");

        let after_ack = poll_mailbox_v2(
            State(state.clone()),
            Extension(AuthNode("receiver".to_string())),
            Json(MailboxPollReq {
                limit: Some(2000),
                after: None,
            }),
        )
        .await
        .expect("poll after ack")
        .0;
        assert_eq!(after_ack.entries.len(), 0, "every chunked id was acked");

        // Sanity-check the DB itself — the table should be empty for this target.
        let conn = state.open_connection().unwrap();
        let remaining: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM server_mailbox WHERE target_node_id = ?1",
                params!["receiver"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(remaining, 0);
    }
}
