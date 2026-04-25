use rusqlite::Connection;

use super::{
    append_message_in_db, create_delegated_exchange_in_db, json_from_db, open_db,
    open_or_create_session_in_db, query_all, select_delegated_exchange, select_identity,
    select_message, select_session, update_presence_in_db, upsert_identity_in_db,
    AppendCanonicalMessageRequest, CanonicalContextSnapshot, CanonicalPresence,
    CanonicalSessionParticipant, CanonicalSessionState, CreateCanonicalDelegatedExchangeRequest,
    OpenCanonicalSessionRequest, UpdateCanonicalPresenceRequest, UpsertCanonicalIdentityRequest,
};

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
        "SELECT session_id, identity_id, role, state, added_by_identity_id, added_at_ms, last_seen_at_ms, last_read_message_id, metadata_json
         FROM session_participants ORDER BY session_id ASC, added_at_ms ASC, identity_id ASC",
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
                metadata: json_from_db(row.get(8)?),
            })
        },
    )?;
    let messages = query_all(
        conn,
        "SELECT id FROM session_messages ORDER BY session_id ASC, sequence_num ASC",
        |row| row.get::<_, String>(0),
    )?
    .into_iter()
    .filter_map(|id| select_message(conn, &id).ok().flatten())
    .collect();
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
