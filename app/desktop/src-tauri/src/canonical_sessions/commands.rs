use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::{Map, Value};

use super::{
    add_session_participants_in_db, adopt_cloud_profile_identity_in_db, append_message_in_db,
    create_delegated_exchange_in_db, hash_hex, json_from_db, mark_session_read_in_db, now_ms,
    open_db, open_or_create_session_in_db, remove_session_participant_in_db,
    rename_any_session_title_in_db, rename_session_in_db, require_group_admin,
    select_delegated_exchange, select_identity, select_session, set_session_metadata_in_db,
    set_session_participant_role_in_db, update_presence_in_db, upsert_identity_in_db,
    upsert_message_in_db, AddCanonicalSessionParticipantsRequest, AdoptCloudProfileIdentityRequest,
    AppendCanonicalMessageRequest, CanonicalContextSnapshot, CanonicalDelegatedExchange,
    CanonicalIdentity, CanonicalMessageDeliveryDelta, CanonicalMessagePage, CanonicalPresence,
    CanonicalProfileIdentityDelta, CanonicalReadCursorDelta, CanonicalSession,
    CanonicalSessionCatalog, CanonicalSessionMessage, CanonicalSessionParticipant,
    CanonicalSessionState, CanonicalSessionSummary, CreateCanonicalDelegatedExchangeRequest,
    MarkCanonicalSessionReadRequest, OpenCanonicalSessionFastResult, OpenCanonicalSessionRequest,
    RemoveCanonicalSessionParticipantRequest, RenameCanonicalSessionRequest,
    SetCanonicalSessionParticipantRoleRequest, UpdateCanonicalMessageDeliveryRequest,
    UpdateCanonicalPresenceRequest, UpdateCanonicalSessionMetadataRequest,
    UpsertCanonicalIdentityRequest,
};

fn query_all<T>(
    conn: &Connection,
    sql: &str,
    map: impl Fn(&rusqlite::Row<'_>) -> rusqlite::Result<T>,
) -> Result<Vec<T>, String> {
    let mut stmt = conn.prepare(sql).map_err(|err| err.to_string())?;
    let rows = stmt.query_map([], map).map_err(|err| err.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())
}

fn canonical_message_from_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<CanonicalSessionMessage> {
    Ok(CanonicalSessionMessage {
        id: row.get(0)?,
        session_id: row.get(1)?,
        sender_identity_id: row.get(2)?,
        sender_role: row.get(3)?,
        message_kind: row.get(4)?,
        content_text: row.get(5)?,
        content: json_from_db(row.get(6)?),
        parent_message_id: row.get(7)?,
        delegated_exchange_id: row.get(8)?,
        status: row.get(9)?,
        sequence_num: row.get(10)?,
        created_at_ms: row.get(11)?,
        updated_at_ms: row.get(12)?,
        content_hash: row.get(13)?,
        source_transport: row.get(14)?,
        source_event_id: row.get(15)?,
    })
}

fn canonical_identity_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<CanonicalIdentity> {
    Ok(CanonicalIdentity {
        id: row.get(0)?,
        kind: row.get(1)?,
        display_name: row.get(2)?,
        owner_identity_id: row.get(3)?,
        source: row.get(4)?,
        source_host_id: row.get(5)?,
        bridge_node_id: row.get(6)?,
        human_id: row.get(7)?,
        agent_id: row.get(8)?,
        avatar_key: row.get(9)?,
        profile_image_url: row.get(10)?,
        metadata: json_from_db(row.get(11)?),
        created_at_ms: row.get(12)?,
        updated_at_ms: row.get(13)?,
    })
}

fn canonical_session_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<CanonicalSession> {
    Ok(CanonicalSession {
        id: row.get(0)?,
        kind: row.get(1)?,
        title: row.get(2)?,
        status: row.get(3)?,
        created_by_identity_id: row.get(4)?,
        primary_identity_id: row.get(5)?,
        project_id: row.get(6)?,
        project_name: row.get(7)?,
        relationship_identity_id: row.get(8)?,
        metadata: json_from_db(row.get(9)?),
        created_at_ms: row.get(10)?,
        updated_at_ms: row.get(11)?,
        last_message_at_ms: row.get(12)?,
    })
}

fn canonical_delegated_exchange_from_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<CanonicalDelegatedExchange> {
    Ok(CanonicalDelegatedExchange {
        id: row.get(0)?,
        session_id: row.get(1)?,
        initiator_identity_id: row.get(2)?,
        target_identity_id: row.get(3)?,
        trigger_message_id: row.get(4)?,
        request_message_id: row.get(5)?,
        response_message_id: row.get(6)?,
        transport: row.get(7)?,
        bridge_host_id: row.get(8)?,
        bridge_conversation_id: row.get(9)?,
        bridge_request_id: row.get(10)?,
        context_policy: row.get(11)?,
        status: row.get(12)?,
        error: row.get(13)?,
        created_at_ms: row.get(14)?,
        updated_at_ms: row.get(15)?,
    })
}

fn load_catalog_from_db(conn: &Connection) -> Result<CanonicalSessionCatalog, String> {
    let path = super::canonical_sessions_db_path();
    let profile = super::schema::ensure_local_profile(conn)?;
    let identities = query_all(
        conn,
        "SELECT id, kind, display_name, owner_identity_id, source, source_host_id, bridge_node_id,
                human_id, agent_id, avatar_key, profile_image_url, metadata_json, created_at_ms, updated_at_ms
         FROM identities ORDER BY kind ASC, display_name ASC, id ASC",
        canonical_identity_from_row,
    )?;
    let sessions = query_all(
        conn,
        "SELECT id, kind, title, status, created_by_identity_id, primary_identity_id, project_id,
                project_name, relationship_identity_id, metadata_json, created_at_ms, updated_at_ms, last_message_at_ms
         FROM sessions ORDER BY updated_at_ms DESC, created_at_ms DESC, id ASC",
        canonical_session_from_row,
    )?;
    let participants = query_all(
        conn,
        "SELECT participant.session_id, participant.identity_id, participant.role, participant.state,
                participant.added_by_identity_id, participant.added_at_ms, participant.last_seen_at_ms,
                participant.last_read_message_id,
                (
                    SELECT message.sequence_num
                    FROM session_messages AS message
                    WHERE message.id = participant.last_read_message_id
                      AND message.session_id = participant.session_id
                ),
                participant.metadata_json
         FROM session_participants AS participant
         ORDER BY participant.session_id ASC, participant.added_at_ms ASC, participant.identity_id ASC",
        |row| {
            Ok(CanonicalSessionParticipant {
                session_id: row.get(0)?,
                identity_id: row.get(1)?,
                role: row.get(2)?,
                state: row.get(3)?,
                added_by_identity_id: row.get(4)?,
                added_at_ms: row.get(5)?,
                last_seen_at_ms: row.get(6)?,
                last_read_message_id: row.get(7)?,
                last_read_sequence_num: row.get(8)?,
                metadata: json_from_db(row.get(9)?),
            })
        },
    )?;
    let delegated_exchanges = query_all(
        conn,
        "SELECT id, session_id, initiator_identity_id, target_identity_id, trigger_message_id,
                request_message_id, response_message_id, transport, bridge_host_id,
                bridge_conversation_id, bridge_request_id, context_policy, status, error,
                created_at_ms, updated_at_ms
         FROM delegated_exchanges ORDER BY updated_at_ms DESC, id ASC",
        canonical_delegated_exchange_from_row,
    )?;
    let presence = query_all(
        conn,
        "SELECT identity_id, status, session_id, detail, updated_at_ms, expires_at_ms FROM presence ORDER BY updated_at_ms DESC",
        |row| {
            Ok(CanonicalPresence {
                identity_id: row.get(0)?,
                status: row.get(1)?,
                session_id: row.get(2)?,
                detail: row.get(3)?,
                updated_at_ms: row.get(4)?,
                expires_at_ms: row.get(5)?,
            })
        },
    )?;

    let summaries = {
        let mut stmt = conn
            .prepare(
                "WITH ranked_messages AS (
                    SELECT
                        sm.*,
                        COUNT(*) OVER (PARTITION BY sm.session_id) AS message_count,
                        ROW_NUMBER() OVER (
                            PARTITION BY sm.session_id
                            ORDER BY sm.sequence_num DESC, sm.created_at_ms DESC, sm.id DESC
                        ) AS row_rank
                    FROM session_messages sm
                    WHERE COALESCE(sm.source_transport, '') NOT IN (
                        'canonical-fork-snapshot',
                        'cloud-group-fork-snapshot'
                    )
                      AND LOWER(TRIM(COALESCE(sm.status, ''))) NOT IN ('sending', 'processing')
                ),
                context_counts AS (
                    SELECT session_id, COUNT(*) AS context_snapshot_count
                    FROM context_snapshots
                    GROUP BY session_id
                )
                SELECT
                    s.id AS session_id,
                    COALESCE(rm.message_count, 0) AS message_count,
                    rm.id,
                    rm.sender_identity_id,
                    rm.sender_role,
                    rm.message_kind,
                    rm.content_text,
                    rm.content_json,
                    rm.parent_message_id,
                    rm.delegated_exchange_id,
                    rm.status,
                    rm.sequence_num,
                    rm.created_at_ms,
                    rm.updated_at_ms,
                    rm.content_hash,
                    rm.source_transport,
                    rm.source_event_id,
                    COALESCE(cc.context_snapshot_count, 0) AS context_snapshot_count
                FROM sessions s
                LEFT JOIN ranked_messages rm
                  ON rm.session_id = s.id
                 AND rm.row_rank = 1
                LEFT JOIN context_counts cc ON cc.session_id = s.id
                ORDER BY COALESCE(s.last_message_at_ms, s.updated_at_ms) DESC, s.id",
            )
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                let latest_message = if let Some(id) = row.get::<_, Option<String>>(2)? {
                    Some(CanonicalSessionMessage {
                        id,
                        session_id: row.get(0)?,
                        sender_identity_id: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                        sender_role: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                        message_kind: row.get::<_, Option<String>>(5)?.unwrap_or_default(),
                        content_text: row.get::<_, Option<String>>(6)?.unwrap_or_default(),
                        content: json_from_db(row.get(7)?),
                        parent_message_id: row.get(8)?,
                        delegated_exchange_id: row.get(9)?,
                        status: row.get::<_, Option<String>>(10)?.unwrap_or_default(),
                        sequence_num: row.get::<_, Option<i64>>(11)?.unwrap_or_default(),
                        created_at_ms: row.get::<_, Option<i64>>(12)?.unwrap_or_default(),
                        updated_at_ms: row.get::<_, Option<i64>>(13)?.unwrap_or_default(),
                        content_hash: row.get(14)?,
                        source_transport: row.get(15)?,
                        source_event_id: row.get(16)?,
                    })
                } else {
                    None
                };
                Ok(CanonicalSessionSummary {
                    session_id: row.get(0)?,
                    message_count: row.get(1)?,
                    latest_message,
                    context_snapshot_count: row.get(17)?,
                })
            })
            .map_err(|err| err.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|err| err.to_string())?
    };

    Ok(CanonicalSessionCatalog {
        storage_path: path.display().to_string(),
        profile,
        identities,
        sessions,
        participants,
        delegated_exchanges,
        presence,
        summaries,
    })
}

pub(super) fn desktop_canonical_session_catalog() -> Result<CanonicalSessionCatalog, String> {
    let conn = open_db()?;
    load_catalog_from_db(&conn)
}

fn load_message_page_from_db(
    conn: &Connection,
    session_id: &str,
    before_sequence_num: Option<i64>,
    limit: Option<i64>,
) -> Result<CanonicalMessagePage, String> {
    let session_id = session_id.trim();
    if session_id.is_empty() {
        return Err("Session id is required".to_string());
    }
    let limit = limit.unwrap_or(100).clamp(25, 200) as usize;
    let mut stmt = conn
        .prepare(
            "SELECT
                id, session_id, sender_identity_id, sender_role, message_kind,
                content_text, content_json, parent_message_id, delegated_exchange_id,
                status, sequence_num, created_at_ms, updated_at_ms, content_hash,
                source_transport, source_event_id
             FROM session_messages
             WHERE session_id = ?1
               AND (?2 IS NULL OR sequence_num < ?2)
             ORDER BY sequence_num DESC, created_at_ms DESC, id DESC
             LIMIT ?3",
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(
            params![session_id, before_sequence_num, (limit + 1) as i64],
            canonical_message_from_row,
        )
        .map_err(|err| err.to_string())?;
    let mut messages = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;
    let has_older = messages.len() > limit;
    messages.truncate(limit);
    messages.reverse();
    let oldest_sequence_num = messages.first().map(|message| message.sequence_num);
    let newest_sequence_num = messages.last().map(|message| message.sequence_num);

    Ok(CanonicalMessagePage {
        session_id: session_id.to_string(),
        messages,
        oldest_sequence_num,
        newest_sequence_num,
        has_older,
    })
}

pub(super) fn desktop_canonical_session_messages(
    session_id: &str,
    before_sequence_num: Option<i64>,
    limit: Option<i64>,
) -> Result<CanonicalMessagePage, String> {
    let conn = open_db()?;
    load_message_page_from_db(&conn, session_id, before_sequence_num, limit)
}

pub(super) fn load_state_from_db(conn: &Connection) -> Result<CanonicalSessionState, String> {
    let path = super::canonical_sessions_db_path();
    let profile = super::schema::ensure_local_profile(conn)?;
    let identities = query_all(
        conn,
        "SELECT id FROM identities ORDER BY kind ASC, display_name ASC, id ASC",
        |row| row.get::<_, String>(0),
    )?
    .into_iter()
    .filter_map(|id| select_identity(conn, &id).ok().flatten())
    .collect();
    let sessions = query_all(
        conn,
        "SELECT id FROM sessions ORDER BY updated_at_ms DESC, created_at_ms DESC, id ASC",
        |row| row.get::<_, String>(0),
    )?
    .into_iter()
    .filter_map(|id| select_session(conn, &id).ok().flatten())
    .collect();
    let participants = query_all(
        conn,
        "SELECT participant.session_id, participant.identity_id, participant.role, participant.state,
                participant.added_by_identity_id, participant.added_at_ms, participant.last_seen_at_ms,
                participant.last_read_message_id,
                (
                    SELECT message.sequence_num
                    FROM session_messages AS message
                    WHERE message.id = participant.last_read_message_id
                      AND message.session_id = participant.session_id
                ),
                participant.metadata_json
         FROM session_participants AS participant
         ORDER BY participant.session_id ASC, participant.added_at_ms ASC, participant.identity_id ASC",
        |row| {
            Ok(CanonicalSessionParticipant {
                session_id: row.get(0)?,
                identity_id: row.get(1)?,
                role: row.get(2)?,
                state: row.get(3)?,
                added_by_identity_id: row.get(4)?,
                added_at_ms: row.get(5)?,
                last_seen_at_ms: row.get(6)?,
                last_read_message_id: row.get(7)?,
                last_read_sequence_num: row.get(8)?,
                metadata: json_from_db(row.get(9)?),
            })
        },
    )?;
    let messages = query_all(
        conn,
        "SELECT id, session_id, sender_identity_id, sender_role, message_kind, content_text, content_json,
                parent_message_id, delegated_exchange_id, status, sequence_num, created_at_ms, updated_at_ms,
                content_hash, source_transport, source_event_id
         FROM session_messages ORDER BY session_id ASC, sequence_num ASC",
        |row| {
            Ok(CanonicalSessionMessage {
                id: row.get(0)?,
                session_id: row.get(1)?,
                sender_identity_id: row.get(2)?,
                sender_role: row.get(3)?,
                message_kind: row.get(4)?,
                content_text: row.get(5)?,
                content: json_from_db(row.get(6)?),
                parent_message_id: row.get(7)?,
                delegated_exchange_id: row.get(8)?,
                status: row.get(9)?,
                sequence_num: row.get(10)?,
                created_at_ms: row.get(11)?,
                updated_at_ms: row.get(12)?,
                content_hash: row.get(13)?,
                source_transport: row.get(14)?,
                source_event_id: row.get(15)?,
            })
        },
    )?;
    let delegated_exchanges = query_all(
        conn,
        "SELECT id FROM delegated_exchanges ORDER BY updated_at_ms DESC, id ASC",
        |row| row.get::<_, String>(0),
    )?
    .into_iter()
    .filter_map(|id| select_delegated_exchange(conn, &id).ok().flatten())
    .collect();
    let presence = query_all(
        conn,
        "SELECT identity_id, status, session_id, detail, updated_at_ms, expires_at_ms FROM presence ORDER BY updated_at_ms DESC",
        |row| {
            Ok(CanonicalPresence {
                identity_id: row.get(0)?,
                status: row.get(1)?,
                session_id: row.get(2)?,
                detail: row.get(3)?,
                updated_at_ms: row.get(4)?,
                expires_at_ms: row.get(5)?,
            })
        },
    )?;
    let context_snapshots = query_all(
        conn,
        "SELECT id, profile_id, session_id, agent_identity_id, provider, model, prompt_hash, project_context_hash,
                participant_hash, upto_message_id, message_range_hash, summary_text, summary_json, token_count, created_at_ms, invalidated_at_ms
         FROM context_snapshots ORDER BY created_at_ms DESC, id ASC",
        |row| {
            Ok(CanonicalContextSnapshot {
                id: row.get(0)?,
                profile_id: row.get(1)?,
                session_id: row.get(2)?,
                agent_identity_id: row.get(3)?,
                provider: row.get(4)?,
                model: row.get(5)?,
                prompt_hash: row.get(6)?,
                project_context_hash: row.get(7)?,
                participant_hash: row.get(8)?,
                upto_message_id: row.get(9)?,
                message_range_hash: row.get(10)?,
                summary_text: row.get(11)?,
                summary_json: json_from_db(row.get(12)?),
                token_count: row.get(13)?,
                created_at_ms: row.get(14)?,
                invalidated_at_ms: row.get(15)?,
            })
        },
    )?;

    Ok(CanonicalSessionState {
        storage_path: path.display().to_string(),
        profile,
        identities,
        sessions,
        participants,
        messages,
        delegated_exchanges,
        presence,
        context_snapshots,
    })
}

pub(super) fn desktop_canonical_session_state() -> Result<CanonicalSessionState, String> {
    let conn = open_db()?;
    load_state_from_db(&conn)
}

pub(super) fn desktop_canonical_upsert_identity(
    request: UpsertCanonicalIdentityRequest,
) -> Result<CanonicalSessionState, String> {
    let conn = open_db()?;
    upsert_identity_in_db(&conn, request)?;
    load_state_from_db(&conn)
}

pub(super) fn desktop_canonical_adopt_cloud_profile_identity(
    request: AdoptCloudProfileIdentityRequest,
) -> Result<CanonicalProfileIdentityDelta, String> {
    let mut conn = open_db()?;
    adopt_cloud_profile_identity_in_db(&mut conn, request)
}

pub(super) fn desktop_canonical_upsert_identity_fast(
    request: UpsertCanonicalIdentityRequest,
) -> Result<CanonicalIdentity, String> {
    let conn = open_db()?;
    upsert_identity_in_db(&conn, request)
}

fn select_session_participants(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<CanonicalSessionParticipant>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT participant.session_id, participant.identity_id, participant.role, participant.state,
                    participant.added_by_identity_id, participant.added_at_ms, participant.last_seen_at_ms,
                    participant.last_read_message_id,
                    (
                        SELECT message.sequence_num
                        FROM session_messages AS message
                        WHERE message.id = participant.last_read_message_id
                          AND message.session_id = participant.session_id
                    ),
                    participant.metadata_json
             FROM session_participants AS participant
             WHERE participant.session_id = ?1
             ORDER BY participant.added_at_ms ASC, participant.identity_id ASC",
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map([session_id], |row| {
            Ok(CanonicalSessionParticipant {
                session_id: row.get(0)?,
                identity_id: row.get(1)?,
                role: row.get(2)?,
                state: row.get(3)?,
                added_by_identity_id: row.get(4)?,
                added_at_ms: row.get(5)?,
                last_seen_at_ms: row.get(6)?,
                last_read_message_id: row.get(7)?,
                last_read_sequence_num: row.get(8)?,
                metadata: json_from_db(row.get(9)?),
            })
        })
        .map_err(|err| err.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())
}

pub(super) fn desktop_canonical_open_or_create_session_fast(
    request: OpenCanonicalSessionRequest,
) -> Result<OpenCanonicalSessionFastResult, String> {
    let conn = open_db()?;
    let session = open_or_create_session_in_db(&conn, request)?;
    let participants = select_session_participants(&conn, &session.id)?;
    Ok(OpenCanonicalSessionFastResult {
        session,
        participants,
    })
}

pub(super) fn desktop_canonical_open_or_create_session(
    request: OpenCanonicalSessionRequest,
) -> Result<CanonicalSessionState, String> {
    let conn = open_db()?;
    open_or_create_session_in_db(&conn, request)?;
    load_state_from_db(&conn)
}

pub(super) fn desktop_canonical_append_message(
    request: AppendCanonicalMessageRequest,
) -> Result<CanonicalSessionState, String> {
    let conn = open_db()?;
    append_message_in_db(&conn, request)?;
    load_state_from_db(&conn)
}

pub(super) fn desktop_canonical_upsert_message(
    request: AppendCanonicalMessageRequest,
) -> Result<CanonicalSessionState, String> {
    let conn = open_db()?;
    upsert_message_in_db(&conn, request)?;
    load_state_from_db(&conn)
}

pub(super) fn desktop_canonical_upsert_message_fast(
    request: AppendCanonicalMessageRequest,
) -> Result<CanonicalSessionMessage, String> {
    let conn = open_db()?;
    upsert_message_in_db(&conn, request)
}

pub(super) fn desktop_canonical_append_message_fast(
    request: AppendCanonicalMessageRequest,
) -> Result<CanonicalSessionMessage, String> {
    let conn = open_db()?;
    append_message_in_db(&conn, request)
}

fn validate_outbox_delivery_value(
    value: String,
    allowed: &[&str],
    label: &str,
) -> Result<String, String> {
    let value = value.trim();
    if allowed.contains(&value) {
        Ok(value.to_string())
    } else {
        Err(format!("Invalid canonical message {label}: {value}"))
    }
}

fn validate_recipient_ids(ids: Vec<String>, label: &str) -> Result<Vec<String>, String> {
    ids.into_iter()
        .map(|id| {
            let id = id.trim();
            if id.is_empty() {
                Err(format!(
                    "Canonical message {label} must not contain blank ids"
                ))
            } else {
                Ok(id.to_string())
            }
        })
        .collect()
}

fn update_canonical_message_delivery_in_db(
    conn: &mut Connection,
    request: UpdateCanonicalMessageDeliveryRequest,
) -> Result<Option<CanonicalMessageDeliveryDelta>, String> {
    let message_id = request.message_id.trim();
    if message_id.is_empty() {
        return Err("Message id is required".to_string());
    }
    let session_id = request.session_id.trim();
    if session_id.is_empty() {
        return Err("Session id is required".to_string());
    }
    let status = validate_outbox_delivery_value(
        request.status,
        &["sending", "delivered", "failed"],
        "status",
    )?;
    let delivery_state = validate_outbox_delivery_value(
        request.delivery_state,
        &["sending", "partial", "delivered", "failed"],
        "delivery state",
    )?;
    let delivered_recipient_ids =
        validate_recipient_ids(request.delivered_recipient_ids, "delivered recipient ids")?;
    let pending_recipient_ids =
        validate_recipient_ids(request.pending_recipient_ids, "pending recipient ids")?;
    let exhausted_recipient_ids =
        validate_recipient_ids(request.exhausted_recipient_ids, "exhausted recipient ids")?;

    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|err| err.to_string())?;
    let row = tx
        .query_row(
            "SELECT session_id, content_text, content_json, created_at_ms
             FROM session_messages WHERE id = ?1",
            params![message_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            },
        )
        .optional()
        .map_err(|err| err.to_string())?;
    let Some((stored_session_id, content_text, content_json, created_at_ms)) = row else {
        tx.commit().map_err(|err| err.to_string())?;
        return Ok(None);
    };
    if stored_session_id != session_id {
        return Err(format!(
            "Canonical message {message_id} belongs to session {stored_session_id}, not {session_id}"
        ));
    }

    let mut content = match content_json {
        Some(content_json) => {
            match serde_json::from_str::<Value>(&content_json).map_err(|err| err.to_string())? {
                Value::Object(content) => content,
                _ => Map::new(),
            }
        }
        None => Map::new(),
    };
    content.insert(
        "deliveryState".to_string(),
        Value::String(delivery_state.clone()),
    );
    content.insert(
        "deliveredRecipientIds".to_string(),
        serde_json::to_value(&delivered_recipient_ids).map_err(|err| err.to_string())?,
    );
    content.insert(
        "pendingRecipientIds".to_string(),
        serde_json::to_value(&pending_recipient_ids).map_err(|err| err.to_string())?,
    );
    content.insert(
        "exhaustedRecipientIds".to_string(),
        serde_json::to_value(&exhausted_recipient_ids).map_err(|err| err.to_string())?,
    );
    let content_json =
        serde_json::to_string(&Value::Object(content)).map_err(|err| err.to_string())?;
    let content_hash = hash_hex(&format!("{content_text}|{content_json}"), 16);
    let updated_at_ms = now_ms();

    tx.execute(
        "UPDATE session_messages
         SET status = ?1, content_json = ?2, updated_at_ms = ?3, content_hash = ?4
         WHERE id = ?5 AND session_id = ?6",
        params![
            status,
            content_json,
            updated_at_ms,
            content_hash,
            message_id,
            session_id,
        ],
    )
    .map_err(|err| err.to_string())?;
    tx.execute(
        "UPDATE sessions
         SET updated_at_ms = ?1,
             last_message_at_ms = MAX(COALESCE(last_message_at_ms, 0), ?2)
         WHERE id = ?3",
        params![updated_at_ms, created_at_ms, session_id],
    )
    .map_err(|err| err.to_string())?;
    let (content_hash, session_updated_at_ms, session_last_message_at_ms) = tx
        .query_row(
            "SELECT sm.content_hash, s.updated_at_ms, s.last_message_at_ms
             FROM session_messages sm
             JOIN sessions s ON s.id = sm.session_id
             WHERE sm.id = ?1 AND sm.session_id = ?2",
            params![message_id, session_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                ))
            },
        )
        .map_err(|err| err.to_string())?;
    tx.commit().map_err(|err| err.to_string())?;

    Ok(Some(CanonicalMessageDeliveryDelta {
        message_id: message_id.to_string(),
        session_id: session_id.to_string(),
        status,
        delivery_state,
        delivered_recipient_ids,
        pending_recipient_ids,
        exhausted_recipient_ids,
        updated_at_ms,
        content_hash,
        session_updated_at_ms,
        session_last_message_at_ms,
    }))
}

pub(super) fn desktop_canonical_update_message_delivery(
    request: UpdateCanonicalMessageDeliveryRequest,
) -> Result<Option<CanonicalMessageDeliveryDelta>, String> {
    let mut conn = open_db()?;
    update_canonical_message_delivery_in_db(&mut conn, request)
}

pub(super) fn desktop_canonical_create_delegated_exchange(
    request: CreateCanonicalDelegatedExchangeRequest,
) -> Result<CanonicalSessionState, String> {
    let conn = open_db()?;
    create_delegated_exchange_in_db(&conn, request)?;
    load_state_from_db(&conn)
}

pub(super) fn desktop_canonical_update_presence(
    request: UpdateCanonicalPresenceRequest,
) -> Result<CanonicalSessionState, String> {
    let conn = open_db()?;
    update_presence_in_db(&conn, request)?;
    load_state_from_db(&conn)
}

pub(super) fn desktop_canonical_rename_session(
    request: RenameCanonicalSessionRequest,
) -> Result<CanonicalSessionState, String> {
    let conn = open_db()?;
    let session = select_session(&conn, &request.session_id)?
        .ok_or_else(|| "Session not found".to_string())?;
    let _requested_by_identity_id = request.requested_by_identity_id.as_deref();
    if session.kind == "group" {
        rename_session_in_db(&conn, &request.session_id, &request.title)?;
    } else {
        rename_any_session_title_in_db(&conn, &request.session_id, &request.title)?;
    }
    load_state_from_db(&conn)
}

pub(super) fn desktop_canonical_update_session_metadata(
    request: UpdateCanonicalSessionMetadataRequest,
) -> Result<CanonicalSessionState, String> {
    let conn = open_db()?;
    require_group_admin(
        &conn,
        &request.session_id,
        request.requested_by_identity_id.as_deref(),
        "change this group",
    )?;
    set_session_metadata_in_db(&conn, &request.session_id, request.metadata)?;
    load_state_from_db(&conn)
}

pub(super) fn desktop_canonical_add_session_participants(
    request: AddCanonicalSessionParticipantsRequest,
) -> Result<CanonicalSessionState, String> {
    let conn = open_db()?;
    require_group_admin(
        &conn,
        &request.session_id,
        Some(request.added_by_identity_id.as_str()),
        "invite people to this group",
    )?;
    add_session_participants_in_db(
        &conn,
        &request.session_id,
        &request.identity_ids,
        &request.added_by_identity_id,
    )?;
    load_state_from_db(&conn)
}

pub(super) fn desktop_canonical_remove_session_participant(
    request: RemoveCanonicalSessionParticipantRequest,
) -> Result<CanonicalSessionState, String> {
    let conn = open_db()?;
    require_group_admin(
        &conn,
        &request.session_id,
        request.removed_by_identity_id.as_deref(),
        "remove people from this group",
    )?;
    remove_session_participant_in_db(&conn, &request.session_id, &request.identity_id)?;
    load_state_from_db(&conn)
}

pub(super) fn desktop_canonical_set_session_participant_role(
    request: SetCanonicalSessionParticipantRoleRequest,
) -> Result<CanonicalSessionState, String> {
    let conn = open_db()?;
    require_group_admin(
        &conn,
        &request.session_id,
        request.requested_by_identity_id.as_deref(),
        "change group admins",
    )?;
    set_session_participant_role_in_db(
        &conn,
        &request.session_id,
        &request.identity_id,
        &request.role,
    )?;
    load_state_from_db(&conn)
}

pub(super) fn desktop_canonical_mark_session_read(
    request: MarkCanonicalSessionReadRequest,
) -> Result<Option<CanonicalReadCursorDelta>, String> {
    let conn = open_db()?;
    mark_session_read_in_db(&conn, request)
}

pub(crate) fn session_exists(session_id: &str) -> Result<bool, String> {
    let conn = open_db()?;
    let exists = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sessions WHERE id = ?1)",
            rusqlite::params![session_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|err| err.to_string())?;
    Ok(exists != 0)
}

pub(crate) fn archive_session(session_id: &str) -> Result<(), String> {
    let conn = open_db()?;
    conn.execute(
        "UPDATE sessions SET status = 'archived', updated_at_ms = ?2 WHERE id = ?1",
        rusqlite::params![session_id, super::now_ms()],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

pub(crate) fn delete_session(session_id: &str) -> Result<(), String> {
    let conn = open_db()?;
    conn.execute(
        "DELETE FROM kv_cache_entries WHERE session_id = ?1",
        rusqlite::params![session_id],
    )
    .map_err(|err| err.to_string())?;
    conn.execute(
        "DELETE FROM context_snapshots WHERE session_id = ?1",
        rusqlite::params![session_id],
    )
    .map_err(|err| err.to_string())?;
    conn.execute(
        "DELETE FROM presence WHERE session_id = ?1",
        rusqlite::params![session_id],
    )
    .map_err(|err| err.to_string())?;
    conn.execute(
        "DELETE FROM delegated_exchanges WHERE session_id = ?1",
        rusqlite::params![session_id],
    )
    .map_err(|err| err.to_string())?;
    conn.execute(
        "DELETE FROM session_messages WHERE session_id = ?1",
        rusqlite::params![session_id],
    )
    .map_err(|err| err.to_string())?;
    conn.execute(
        "DELETE FROM session_participants WHERE session_id = ?1",
        rusqlite::params![session_id],
    )
    .map_err(|err| err.to_string())?;
    conn.execute(
        "DELETE FROM sessions WHERE id = ?1",
        rusqlite::params![session_id],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

#[cfg(test)]
mod catalog_tests {
    use rusqlite::{params, Connection};

    use super::super::UpdateCanonicalMessageDeliveryRequest;
    use super::{
        load_catalog_from_db, load_message_page_from_db, load_state_from_db,
        select_session_participants, update_canonical_message_delivery_in_db,
    };

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory canonical db");
        super::super::schema::initialize_schema(&conn).expect("initialize canonical schema");
        conn
    }

    fn seed_identity(conn: &Connection) {
        conn.execute(
            "INSERT INTO identities (
                id, kind, display_name, source, avatar_key, created_at_ms, updated_at_ms
             ) VALUES ('human:me', 'human', 'Me', 'local', 'human:me', 1, 1)",
            [],
        )
        .expect("seed identity");
    }

    #[test]
    fn participant_queries_map_the_durable_last_read_sequence() {
        let conn = test_conn();
        seed_identity(&conn);
        conn.execute(
            "INSERT INTO sessions (
                id, kind, title, status, created_by_identity_id,
                created_at_ms, updated_at_ms, last_message_at_ms
             ) VALUES ('session:one', 'group', 'One', 'active', 'human:me', 1, 7, 7)",
            [],
        )
        .expect("seed session");
        conn.execute(
            "INSERT INTO session_messages (
                id, session_id, sender_identity_id, sender_role, message_kind,
                content_text, status, sequence_num, created_at_ms, updated_at_ms
             ) VALUES ('message:seven', 'session:one', 'human:me', 'user', 'text',
                       'Seven', 'sent', 7, 7, 7)",
            [],
        )
        .expect("seed cursor message");
        conn.execute(
            "INSERT INTO session_participants (
                session_id, identity_id, role, state, added_at_ms,
                last_seen_at_ms, last_read_message_id
             ) VALUES ('session:one', 'human:me', 'self', 'active', 1, 7, 'message:seven')",
            [],
        )
        .expect("seed participant cursor");

        let catalog = load_catalog_from_db(&conn).expect("load catalog");
        assert_eq!(catalog.participants[0].last_read_sequence_num, Some(7));
        let state = load_state_from_db(&conn).expect("load full state");
        assert_eq!(state.participants[0].last_read_sequence_num, Some(7));
        let session_participants =
            select_session_participants(&conn, "session:one").expect("load session participants");
        assert_eq!(session_participants[0].last_read_sequence_num, Some(7));

        conn.execute(
            "UPDATE session_participants
             SET last_read_message_id = 'message:missing'
             WHERE session_id = 'session:one' AND identity_id = 'human:me'",
            [],
        )
        .expect("seed missing cursor message");
        let catalog = load_catalog_from_db(&conn).expect("load catalog with missing cursor");
        assert_eq!(catalog.participants[0].last_read_sequence_num, None);
    }

    #[test]
    fn catalog_and_first_page_stay_bounded_with_twenty_thousand_messages() {
        let mut conn = test_conn();
        seed_identity(&conn);
        let padding = "x".repeat(512);
        let content_json = format!(r#"{{"padding":"{padding}"}}"#);
        let tx = conn.transaction().expect("begin seed transaction");
        for session_index in 0..200 {
            let session_id = format!("session:scale:{session_index:04}");
            tx.execute(
                "INSERT INTO sessions (
                    id, kind, title, status, created_by_identity_id,
                    created_at_ms, updated_at_ms, last_message_at_ms
                 ) VALUES (?1, 'group', ?2, 'active', 'human:me', ?3, ?4, ?4)",
                params![
                    session_id,
                    format!("Scale session {session_index}"),
                    session_index as i64,
                    (session_index * 100 + 100) as i64,
                ],
            )
            .expect("seed session");
            for sequence_num in 1..=100 {
                let message_number = session_index * 100 + sequence_num;
                tx.execute(
                    "INSERT INTO session_messages (
                        id, session_id, sender_identity_id, sender_role, message_kind,
                        content_text, content_json, status, sequence_num,
                        created_at_ms, updated_at_ms
                     ) VALUES (?1, ?2, 'human:me', 'user', 'text', ?3, ?4, 'sent', ?5, ?6, ?6)",
                    params![
                        format!("message:{message_number:05}"),
                        session_id,
                        format!("Scale message {message_number}"),
                        content_json,
                        sequence_num as i64,
                        message_number as i64,
                    ],
                )
                .expect("seed message");
            }
        }
        tx.commit().expect("commit scale fixture");

        let catalog = load_catalog_from_db(&conn).expect("load catalog");
        let catalog_bytes = serde_json::to_vec(&catalog)
            .expect("serialize catalog")
            .len();
        assert_eq!(catalog.sessions.len(), 200);
        assert_eq!(catalog.summaries.len(), 200);
        assert_eq!(
            catalog
                .summaries
                .iter()
                .map(|summary| summary.message_count)
                .sum::<i64>(),
            20_000
        );
        assert!(
            catalog_bytes < 1024 * 1024,
            "catalog payload was {catalog_bytes} bytes"
        );

        let page = load_message_page_from_db(&conn, "session:scale:0199", None, Some(100))
            .expect("load latest page");
        let page_bytes = serde_json::to_vec(&page).expect("serialize page").len();
        assert_eq!(page.messages.len(), 100);
        assert!(page.messages.len() <= 150);
        assert!(!page.has_older);
        assert_eq!(page.oldest_sequence_num, Some(1));
        assert_eq!(page.newest_sequence_num, Some(100));
        assert!(
            page_bytes < 512 * 1024,
            "page payload was {page_bytes} bytes"
        );
    }

    #[test]
    fn catalog_summaries_exclude_transient_and_inherited_rows_while_pages_keep_them() {
        let conn = test_conn();
        seed_identity(&conn);
        conn.execute(
            "INSERT INTO sessions (
                id, kind, title, status, created_by_identity_id,
                created_at_ms, updated_at_ms, last_message_at_ms
             ) VALUES ('session:one', 'group', 'One', 'active', 'human:me', 1, 3, 3)",
            [],
        )
        .expect("seed session");
        for (id, status, sequence_num, source_transport) in [
            ("m1", "sent", 1, None),
            ("m2", "sending", 2, None),
            ("m3", "sent", 3, Some("canonical-fork-snapshot")),
        ] {
            conn.execute(
                "INSERT INTO session_messages (
                    id, session_id, sender_identity_id, sender_role, message_kind,
                    content_text, status, sequence_num, created_at_ms, updated_at_ms, source_transport
                 ) VALUES (?1, 'session:one', 'human:me', 'user', 'text', ?1, ?2, ?3, ?3, ?3, ?4)",
                params![id, status, sequence_num, source_transport],
            )
            .expect("seed message");
        }

        let catalog = load_catalog_from_db(&conn).expect("load catalog");
        assert_eq!(catalog.summaries[0].message_count, 1);
        assert_eq!(
            catalog.summaries[0]
                .latest_message
                .as_ref()
                .map(|message| message.id.as_str()),
            Some("m1")
        );
        let page =
            load_message_page_from_db(&conn, "session:one", None, Some(25)).expect("load page");
        assert_eq!(
            page.messages
                .iter()
                .map(|message| message.id.as_str())
                .collect::<Vec<_>>(),
            vec!["m1", "m2", "m3"]
        );
    }

    #[test]
    fn restored_delivery_updates_an_old_message_by_id_with_a_bounded_delta() {
        let mut conn = test_conn();
        seed_identity(&conn);
        conn.execute(
            "INSERT INTO sessions (
                id, kind, title, status, created_by_identity_id,
                created_at_ms, updated_at_ms, last_message_at_ms
             ) VALUES ('session:restored', 'group', 'Restored', 'active', 'human:me', 1, 202, 202)",
            [],
        )
        .expect("seed session");
        let large_text = "t".repeat(512 * 1024);
        let large_content = serde_json::json!({
            "deliveryState": "sending",
            "deliveredRecipientIds": [],
            "pendingRecipientIds": ["acct:a", "acct:b"],
            "exhaustedRecipientIds": [],
            "unrelated": { "keep": true, "large": "x".repeat(512 * 1024) },
        })
        .to_string();
        conn.execute(
            "INSERT INTO session_messages (
                id, session_id, sender_identity_id, sender_role, message_kind,
                content_text, content_json, status, sequence_num,
                created_at_ms, updated_at_ms, content_hash
             ) VALUES ('message:restored-old', 'session:restored', 'human:me', 'user', 'text',
                       ?1, ?2, 'sending', 1, 1, 1, 'old-hash')",
            params![large_text, large_content],
        )
        .expect("seed old restored target");
        let tx = conn.transaction().expect("begin newer-message seed");
        for sequence_num in 2..=202 {
            tx.execute(
                "INSERT INTO session_messages (
                    id, session_id, sender_identity_id, sender_role, message_kind,
                    content_text, content_json, status, sequence_num,
                    created_at_ms, updated_at_ms, content_hash
                 ) VALUES (?1, 'session:restored', 'human:me', 'user', 'text',
                           ?1, '{\"newer\":true}', 'sent', ?2, ?2, ?2, 'newer-hash')",
                params![format!("message:newer:{sequence_num}"), sequence_num],
            )
            .expect("seed newer message");
        }
        tx.commit().expect("commit newer-message seed");

        let delta = update_canonical_message_delivery_in_db(
            &mut conn,
            UpdateCanonicalMessageDeliveryRequest {
                message_id: "message:restored-old".to_string(),
                session_id: "session:restored".to_string(),
                status: "delivered".to_string(),
                delivery_state: "partial".to_string(),
                delivered_recipient_ids: vec!["acct:a".to_string()],
                pending_recipient_ids: Vec::new(),
                exhausted_recipient_ids: vec!["acct:b".to_string()],
            },
        )
        .expect("update restored delivery")
        .expect("old target still exists");

        assert_eq!(delta.message_id, "message:restored-old");
        assert_eq!(delta.session_id, "session:restored");
        assert_eq!(delta.status, "delivered");
        assert_eq!(delta.delivery_state, "partial");
        assert_ne!(delta.content_hash, "old-hash");
        assert_eq!(delta.session_updated_at_ms, delta.updated_at_ms);
        assert_eq!(delta.session_last_message_at_ms, Some(202));
        let serialized = serde_json::to_value(&delta).expect("serialize bounded delivery delta");
        let object = serialized.as_object().expect("delivery delta object");
        let mut keys = object.keys().map(String::as_str).collect::<Vec<_>>();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec![
                "contentHash",
                "deliveredRecipientIds",
                "deliveryState",
                "exhaustedRecipientIds",
                "messageId",
                "pendingRecipientIds",
                "sessionId",
                "sessionLastMessageAtMs",
                "sessionUpdatedAtMs",
                "status",
                "updatedAtMs",
            ]
        );
        assert!(serde_json::to_vec(&delta).expect("encode delta").len() < 512);

        let (status, content_json, content_hash, updated_at_ms): (String, String, String, i64) =
            conn.query_row(
                "SELECT status, content_json, content_hash, updated_at_ms
                 FROM session_messages WHERE id = 'message:restored-old'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .expect("load updated old target");
        assert_eq!(status, "delivered");
        assert_eq!(updated_at_ms, delta.updated_at_ms);
        assert_eq!(content_hash, delta.content_hash);
        let content: serde_json::Value =
            serde_json::from_str(&content_json).expect("parse content");
        assert_eq!(content["unrelated"]["keep"], true);
        assert_eq!(
            content["unrelated"]["large"].as_str().map(str::len),
            Some(512 * 1024)
        );
        assert_eq!(content["deliveryState"], "partial");
        assert_eq!(
            content["deliveredRecipientIds"],
            serde_json::json!(["acct:a"])
        );
        assert_eq!(content["pendingRecipientIds"], serde_json::json!([]));
        assert_eq!(
            content["exhaustedRecipientIds"],
            serde_json::json!(["acct:b"])
        );

        let unchanged_newer_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM session_messages
                 WHERE session_id = 'session:restored' AND sequence_num > 1
                   AND status = 'sent' AND content_json = '{\"newer\":true}'
                   AND content_hash = 'newer-hash' AND updated_at_ms = sequence_num",
                [],
                |row| row.get(0),
            )
            .expect("count unchanged newer rows");
        assert_eq!(unchanged_newer_count, 201);
        let (session_updated_at_ms, last_message_at_ms): (i64, i64) = conn
            .query_row(
                "SELECT updated_at_ms, last_message_at_ms FROM sessions WHERE id = 'session:restored'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("load session timestamps");
        assert_eq!(session_updated_at_ms, delta.updated_at_ms);
        assert_eq!(last_message_at_ms, 202);
    }

    #[test]
    fn delivery_update_validates_ids_and_states_and_distinguishes_missing_from_wrong_session() {
        let mut conn = test_conn();
        seed_identity(&conn);
        conn.execute(
            "INSERT INTO sessions (
                id, kind, title, status, created_by_identity_id, created_at_ms, updated_at_ms
             ) VALUES ('session:one', 'group', 'One', 'active', 'human:me', 1, 1)",
            [],
        )
        .expect("seed session");
        conn.execute(
            "INSERT INTO session_messages (
                id, session_id, sender_identity_id, sender_role, message_kind,
                content_text, content_json, status, sequence_num, created_at_ms, updated_at_ms
             ) VALUES ('message:one', 'session:one', 'human:me', 'user', 'text',
                       'one', '{}', 'sending', 1, 1, 1)",
            [],
        )
        .expect("seed message");
        let request = |message_id: &str, session_id: &str, status: &str, delivery_state: &str| {
            UpdateCanonicalMessageDeliveryRequest {
                message_id: message_id.to_string(),
                session_id: session_id.to_string(),
                status: status.to_string(),
                delivery_state: delivery_state.to_string(),
                delivered_recipient_ids: Vec::new(),
                pending_recipient_ids: vec!["acct:a".to_string()],
                exhausted_recipient_ids: Vec::new(),
            }
        };

        assert!(update_canonical_message_delivery_in_db(
            &mut conn,
            request("message:missing", "session:one", "sending", "sending"),
        )
        .expect("missing rows are not errors")
        .is_none());
        assert!(update_canonical_message_delivery_in_db(
            &mut conn,
            request("message:one", "session:other", "sending", "sending"),
        )
        .expect_err("wrong session must error")
        .contains("session"));
        for invalid in [
            request(" ", "session:one", "sending", "sending"),
            request("message:one", " ", "sending", "sending"),
            request("message:one", "session:one", "sent", "sending"),
            request("message:one", "session:one", "sending", "pending"),
        ] {
            assert!(update_canonical_message_delivery_in_db(&mut conn, invalid).is_err());
        }
    }
}
