use rusqlite::Connection;

use super::{
    add_session_participants_in_db, append_message_in_db, create_delegated_exchange_in_db,
    json_from_db, open_db, open_or_create_session_in_db, remove_session_participant_in_db,
    rename_any_session_title_in_db, rename_session_in_db, require_group_admin,
    select_delegated_exchange, select_identity, select_message, select_session,
    set_session_metadata_in_db, set_session_participant_role_in_db, update_presence_in_db,
    upsert_identity_in_db, AddCanonicalSessionParticipantsRequest, AppendCanonicalMessageRequest,
    CanonicalContextSnapshot, CanonicalPresence, CanonicalSessionParticipant,
    CanonicalSessionState, CreateCanonicalDelegatedExchangeRequest, OpenCanonicalSessionRequest,
    RemoveCanonicalSessionParticipantRequest, RenameCanonicalSessionRequest,
    SetCanonicalSessionParticipantRoleRequest, UpdateCanonicalPresenceRequest,
    UpdateCanonicalSessionMetadataRequest, UpsertCanonicalIdentityRequest,
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

pub(super) fn desktop_canonical_append_message_fast(
    request: AppendCanonicalMessageRequest,
) -> Result<String, String> {
    let conn = open_db()?;
    append_message_in_db(&conn, request).map(|message| message.id)
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
