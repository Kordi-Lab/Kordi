//! Bounded canonical session catalog and summary projection.

use rusqlite::Connection;

use super::super::super::schema::ensure_local_profile;
use super::super::super::{
    canonical_sessions_db_path, json_from_db, open_db, CanonicalPresence, CanonicalSessionCatalog,
    CanonicalSessionMessage, CanonicalSessionParticipant, CanonicalSessionSummary,
};
use super::rows::{
    canonical_delegated_exchange_from_row, canonical_identity_from_row, canonical_session_from_row,
    query_all,
};

pub(in crate::canonical_sessions::commands) fn load_catalog_from_db(
    conn: &Connection,
) -> Result<CanonicalSessionCatalog, String> {
    let path = canonical_sessions_db_path();
    let profile = ensure_local_profile(conn)?;
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
                      AND NOT CASE
                          WHEN LOWER(TRIM(COALESCE(sm.message_kind, ''))) = 'status'
                               AND json_valid(sm.content_json)
                          THEN (
                              LOWER(TRIM(COALESCE(json_extract(sm.content_json, '$.kind'), ''))) = 'session-title-update'
                              AND LOWER(TRIM(COALESCE(json_extract(sm.content_json, '$.scope'), ''))) = 'session'
                              AND LOWER(TRIM(
                                  CASE
                                      WHEN SUBSTR(TRIM(COALESCE(json_extract(sm.content_json, '$.title'), '')), 1, 1) = '#'
                                          THEN SUBSTR(TRIM(COALESCE(json_extract(sm.content_json, '$.title'), '')), 2)
                                      ELSE COALESCE(json_extract(sm.content_json, '$.title'), '')
                                  END
                              )) IN ('new session', 'new chat', 'new fork', 'untitled session', 'session')
                          ) OR (
                              LOWER(TRIM(COALESCE(sm.source_transport, ''))) = 'cloud-group-title-update'
                              AND LOWER(TRIM(COALESCE(json_extract(sm.content_json, '$.kind'), ''))) = 'group-title-update'
                              AND LOWER(TRIM(COALESCE(json_extract(sm.content_json, '$.scope'), ''))) = 'group'
                              AND COALESCE(json_extract(sm.content_json, '$.synchronizationOnly'), 0) = 1
                              AND LOWER(TRIM(COALESCE(json_extract(sm.content_json, '$.sourceControlKind'), '')))
                                  IN ('group-invite', 'group-update')
                          )
                          ELSE 0
                      END
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

pub(in crate::canonical_sessions) fn desktop_canonical_session_catalog(
) -> Result<CanonicalSessionCatalog, String> {
    let conn = open_db()?;
    load_catalog_from_db(&conn)
}
