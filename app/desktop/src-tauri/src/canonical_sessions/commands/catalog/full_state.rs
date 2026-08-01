//! Compatibility projection for callers that still require complete canonical state.

use rusqlite::Connection;

use super::super::super::schema::ensure_local_profile;
use super::super::super::{
    canonical_sessions_db_path, json_from_db, open_db, select_delegated_exchange, select_identity,
    select_session, CanonicalContextSnapshot, CanonicalPresence, CanonicalSessionMessage,
    CanonicalSessionParticipant, CanonicalSessionState,
};
use super::rows::query_all;

pub(in crate::canonical_sessions) fn load_state_from_db(
    conn: &Connection,
) -> Result<CanonicalSessionState, String> {
    let path = canonical_sessions_db_path();
    let profile = ensure_local_profile(conn)?;
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

pub(in crate::canonical_sessions) fn desktop_canonical_session_state(
) -> Result<CanonicalSessionState, String> {
    let conn = open_db()?;
    load_state_from_db(&conn)
}
