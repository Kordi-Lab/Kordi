//! HTTP/WebSocket relay routes and durable mailbox persistence for Bridge node delivery.

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
                        Ok(EnqueueOutcome::Inserted { .. })
                        | Ok(EnqueueOutcome::Duplicate { .. }) => {}
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
#[path = "relay_test_support.rs"]
mod relay_test_support;

#[cfg(test)]
mod tests;
