//! Identity, session lifecycle, presence, and read-cursor command orchestration.

use super::super::{
    adopt_cloud_profile_identity_in_db, mark_session_read_in_db, open_db,
    open_or_create_session_in_db, update_presence_in_db, upsert_identity_in_db,
    AdoptCloudProfileIdentityRequest, CanonicalIdentity, CanonicalProfileIdentityDelta,
    CanonicalReadCursorDelta, CanonicalSessionState, MarkCanonicalSessionReadRequest,
    OpenCanonicalSessionFastResult, OpenCanonicalSessionRequest, UpdateCanonicalPresenceRequest,
    UpsertCanonicalIdentityRequest,
};
use super::catalog::load_state_from_db;
use super::groups::select_session_participants;

fn delete_message_rows(
    transaction: &rusqlite::Transaction<'_>,
    rows: &[(String, String)],
) -> Result<Vec<String>, String> {
    for (message_id, _) in rows {
        transaction
            .execute(
                "DELETE FROM session_messages WHERE id = ?1",
                rusqlite::params![message_id],
            )
            .map_err(|error| error.to_string())?;
    }
    for session_id in rows
        .iter()
        .map(|(_, session_id)| session_id)
        .collect::<std::collections::BTreeSet<_>>()
    {
        transaction
            .execute(
                "UPDATE sessions
                 SET last_message_at_ms = (
                   SELECT MAX(created_at_ms) FROM session_messages WHERE session_id = ?1
                 )
                 WHERE id = ?1",
                rusqlite::params![session_id],
            )
            .map_err(|error| error.to_string())?;
    }
    Ok(rows
        .iter()
        .map(|(message_id, _)| message_id.clone())
        .collect())
}

fn canonical_cloud_message_id(source_transport: &str, source_event_id: &str) -> Option<String> {
    match source_transport {
        "cloud-self-agent" | "canonical-fork-snapshot" => Some(source_event_id),
        "cloud-group" | "cloud-group-agent" | "cloud-group-fork-snapshot" => source_event_id
            .strip_prefix(&format!("{source_transport}:"))
            .and_then(|value| value.split(':').next()),
        _ => None,
    }
    .filter(|value| !value.is_empty())
    .map(str::to_string)
}

pub(in crate::canonical_sessions) fn desktop_canonical_upsert_identity(
    request: UpsertCanonicalIdentityRequest,
) -> Result<CanonicalSessionState, String> {
    let conn = open_db()?;
    upsert_identity_in_db(&conn, request)?;
    load_state_from_db(&conn)
}

pub(in crate::canonical_sessions) fn desktop_canonical_adopt_cloud_profile_identity(
    request: AdoptCloudProfileIdentityRequest,
) -> Result<CanonicalProfileIdentityDelta, String> {
    let mut conn = open_db()?;
    adopt_cloud_profile_identity_in_db(&mut conn, request)
}

pub(in crate::canonical_sessions) fn desktop_canonical_upsert_identity_fast(
    request: UpsertCanonicalIdentityRequest,
) -> Result<CanonicalIdentity, String> {
    let conn = open_db()?;
    upsert_identity_in_db(&conn, request)
}

pub(in crate::canonical_sessions) fn desktop_canonical_open_or_create_session_fast(
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

pub(in crate::canonical_sessions) fn desktop_canonical_open_or_create_session(
    request: OpenCanonicalSessionRequest,
) -> Result<CanonicalSessionState, String> {
    let conn = open_db()?;
    open_or_create_session_in_db(&conn, request)?;
    load_state_from_db(&conn)
}

pub(in crate::canonical_sessions) fn desktop_canonical_update_presence(
    request: UpdateCanonicalPresenceRequest,
) -> Result<CanonicalSessionState, String> {
    let conn = open_db()?;
    update_presence_in_db(&conn, request)?;
    load_state_from_db(&conn)
}

pub(in crate::canonical_sessions) fn desktop_canonical_mark_session_read(
    request: MarkCanonicalSessionReadRequest,
) -> Result<Option<CanonicalReadCursorDelta>, String> {
    let conn = open_db()?;
    mark_session_read_in_db(&conn, request)
}

pub(in crate::canonical_sessions) fn desktop_canonical_delete_cloud_message(
    cloud_message_id: &str,
) -> Result<Vec<String>, String> {
    let cloud_message_id = cloud_message_id.trim();
    if cloud_message_id.is_empty() {
        return Err("Cloud message id is required".to_string());
    }
    let mut conn = open_db()?;
    delete_cloud_message_in_db(&mut conn, cloud_message_id)
}

pub(super) fn delete_cloud_message_in_db(
    conn: &mut rusqlite::Connection,
    cloud_message_id: &str,
) -> Result<Vec<String>, String> {
    let transaction = conn.transaction().map_err(|error| error.to_string())?;
    transaction
        .execute(
            "DELETE FROM chat_sync_messages WHERE message_id = ?1",
            rusqlite::params![cloud_message_id],
        )
        .map_err(|error| error.to_string())?;
    let rows = {
        let mut statement = transaction
            .prepare(
                "SELECT id, session_id FROM session_messages
                 WHERE (
                   source_transport LIKE 'cloud-group%'
                   AND (
                     source_event_id = source_transport || ':' || ?1
                     OR source_event_id LIKE source_transport || ':' || ?1 || ':%'
                   )
                 ) OR (
                   source_transport IN ('cloud-self-agent', 'canonical-fork-snapshot')
                   AND source_event_id = ?1
                 )",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(rusqlite::params![cloud_message_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        rows
    };
    let deleted = delete_message_rows(&transaction, &rows)?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(deleted)
}

pub(in crate::canonical_sessions) fn desktop_canonical_prune_missing_cloud_messages(
    account_id: &str,
) -> Result<Vec<String>, String> {
    let account_id = account_id.trim();
    if account_id.is_empty() {
        return Err("Cloud account id is required".to_string());
    }
    let mut conn = open_db()?;
    prune_missing_cloud_messages_in_db(&mut conn, account_id)
}

pub(super) fn prune_missing_cloud_messages_in_db(
    conn: &mut rusqlite::Connection,
    account_id: &str,
) -> Result<Vec<String>, String> {
    let transaction = conn.transaction().map_err(|error| error.to_string())?;
    let live_message_ids = {
        let mut statement = transaction
            .prepare("SELECT message_id FROM chat_sync_messages WHERE account_id = ?1")
            .map_err(|error| error.to_string())?;
        let ids = statement
            .query_map([account_id], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?
            .collect::<Result<std::collections::HashSet<_>, _>>()
            .map_err(|error| error.to_string())?;
        ids
    };
    let rows = {
        let mut statement = transaction
            .prepare(
                "SELECT id, session_id, source_transport, source_event_id
                 FROM session_messages
                 WHERE source_transport IN (
                   'cloud-group', 'cloud-group-agent', 'cloud-group-fork-snapshot',
                   'cloud-self-agent', 'canonical-fork-snapshot'
                 ) AND source_event_id IS NOT NULL",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        rows
    };
    let stale_rows = rows
        .into_iter()
        .filter_map(|(id, session_id, source_transport, source_event_id)| {
            let cloud_message_id = canonical_cloud_message_id(&source_transport, &source_event_id)?;
            (!live_message_ids.contains(&cloud_message_id)).then_some((id, session_id))
        })
        .collect::<Vec<_>>();
    let deleted = delete_message_rows(&transaction, &stale_rows)?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(deleted)
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
        rusqlite::params![session_id, super::super::now_ms()],
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
