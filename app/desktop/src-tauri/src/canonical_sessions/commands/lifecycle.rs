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
    let invalidated_at_ms = super::super::now_ms();
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
        // Saved context summaries may quote the removed message, so drop their
        // text (also from already invalidated ones) and rebuild context later.
        transaction
            .execute(
                "UPDATE context_snapshots
                 SET invalidated_at_ms = COALESCE(invalidated_at_ms, ?2),
                     summary_text = NULL, summary_json = NULL
                 WHERE session_id = ?1 AND (
                   invalidated_at_ms IS NULL OR summary_text IS NOT NULL OR summary_json IS NOT NULL
                 )",
                rusqlite::params![session_id, invalidated_at_ms],
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
        "cloud-group" | "cloud-group-agent" => source_event_id
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
    account_id: Option<&str>,
) -> Result<Vec<String>, String> {
    let cloud_message_id = cloud_message_id.trim();
    if cloud_message_id.is_empty() {
        return Err("Cloud message id is required".to_string());
    }
    let active = crate::cloud_account_paths::cloud_account_storage_current()?;
    let account_id = account_id
        .or_else(|| active.as_ref().map(|value| value.account_id.as_str()))
        .ok_or("Cloud account identity is unavailable")?
        .trim();
    let mut conn = super::super::chat_sync::open_account_db(account_id)?;
    delete_cloud_message_in_db(&mut conn, cloud_message_id, account_id)
}

pub(super) fn delete_cloud_message_in_db(
    conn: &mut rusqlite::Connection,
    cloud_message_id: &str,
    account_id: &str,
) -> Result<Vec<String>, String> {
    let transaction = conn.transaction().map_err(|error| error.to_string())?;
    super::super::chat_sync::mark_message_deleted(&transaction, account_id, cloud_message_id)?;
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
                   'cloud-group', 'cloud-group-agent',
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

#[cfg(test)]
mod tests {
    use rusqlite::{params, Connection};

    fn connection() -> Connection {
        let conn = Connection::open_in_memory().expect("open canonical db");
        super::super::super::schema::initialize_schema(&conn).expect("initialize schema");
        conn.execute(
            "INSERT INTO identities (
                id, kind, display_name, source, avatar_key, created_at_ms, updated_at_ms
             ) VALUES ('human:me', 'human', 'Me', 'local', 'human:me', 1, 1)",
            [],
        )
        .expect("seed identity");
        for session_id in ["session:removed", "session:other"] {
            conn.execute(
                "INSERT INTO sessions (
                    id, kind, title, status, created_by_identity_id,
                    created_at_ms, updated_at_ms, last_message_at_ms
                 ) VALUES (?1, 'group', 'Chat', 'active', 'human:me', 1, 1, 1)",
                params![session_id],
            )
            .expect("seed session");
        }
        conn.execute(
            "INSERT INTO session_messages (
                id, session_id, sender_identity_id, sender_role, message_kind,
                content_text, status, sequence_num, created_at_ms, updated_at_ms,
                source_transport, source_event_id
             ) VALUES ('removed', 'session:removed', 'human:me', 'user', 'text',
                'Synthetic text', 'sent', 1, 1, 1, 'cloud-group', 'cloud-group:wire-removed')",
            [],
        )
        .expect("seed message");
        for (id, session_id, invalidated_at_ms) in [
            ("current", "session:removed", None),
            ("older", "session:removed", Some(5_i64)),
            ("other", "session:other", None),
        ] {
            conn.execute(
                "INSERT INTO context_snapshots (
                    id, profile_id, session_id, agent_identity_id, provider, model, prompt_hash,
                    participant_hash, message_range_hash, summary_text, summary_json,
                    created_at_ms, invalidated_at_ms
                 ) VALUES (?1, 'profile', ?2, 'agent', 'provider', 'model', 'prompt',
                    'participants', 'range', 'Synthetic summary', '{}', 1, ?3)",
                params![id, session_id, invalidated_at_ms],
            )
            .expect("seed context snapshot");
        }
        conn
    }

    fn snapshot(conn: &Connection, id: &str) -> (Option<i64>, Option<String>, Option<String>) {
        conn.query_row(
            "SELECT invalidated_at_ms, summary_text, summary_json FROM context_snapshots WHERE id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("read context snapshot")
    }

    #[test]
    fn deleting_a_message_clears_context_summaries_of_its_session_only() {
        let mut conn = connection();
        let deleted = super::delete_cloud_message_in_db(&mut conn, "wire-removed", "acct_me")
            .expect("delete cloud message");
        assert_eq!(deleted, vec!["removed"]);

        let (invalidated, text, json) = snapshot(&conn, "current");
        assert!(invalidated.is_some_and(|value| value > 5));
        assert_eq!((text, json), (None, None));
        assert_eq!(snapshot(&conn, "older"), (Some(5), None, None));
        assert_eq!(
            snapshot(&conn, "other"),
            (None, Some("Synthetic summary".into()), Some("{}".into()))
        );
    }
}
