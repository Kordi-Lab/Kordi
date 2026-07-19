use anyhow::Result;
use chrono::Utc;
use kordi_core::types::SessionEntry;
use rusqlite::{Connection, params};
use uuid::Uuid;

use crate::{
    naming::{SESSION_TITLE_POLICY_VERSION, SessionTitleSource},
    schema,
};

/// Open or create the sessions database.
pub(super) fn open_db(path: &std::path::Path) -> Result<Connection> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let conn = Connection::open(path)?;
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;
    schema::init_schema(&conn)?;
    Ok(conn)
}

/// Open an in-memory database (for testing).
pub(super) fn open_memory() -> Result<Connection> {
    let conn = Connection::open_in_memory()?;
    schema::init_schema(&conn)?;
    Ok(conn)
}

/// Create a new session.
pub(super) fn create_session(conn: &Connection, cwd: &str) -> Result<String> {
    let session_id = Uuid::new_v4().to_string();
    create_session_with_id_and_parent(conn, &session_id, cwd, None, None)?;
    Ok(session_id)
}

pub(super) fn create_session_with_parent(
    conn: &Connection,
    cwd: &str,
    parent_session_id: Option<&str>,
    parent_session_message_id: Option<&str>,
) -> Result<String> {
    let session_id = Uuid::new_v4().to_string();
    create_session_with_id_and_parent(
        conn,
        &session_id,
        cwd,
        parent_session_id,
        parent_session_message_id,
    )?;
    Ok(session_id)
}

/// Create a session with a specific ID (for lazy creation).
pub(super) fn create_session_with_id(conn: &Connection, session_id: &str, cwd: &str) -> Result<()> {
    create_session_with_id_and_parent(conn, session_id, cwd, None, None)
}

pub(super) fn create_session_with_id_and_parent(
    conn: &Connection,
    session_id: &str,
    cwd: &str,
    parent_session_id: Option<&str>,
    parent_session_message_id: Option<&str>,
) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO sessions (
             session_id, cwd, created_at, updated_at, name, leaf_id, entry_count,
             parent_session_id, parent_session_message_id, session_scope, project_root,
             title_source, title_revision, title_policy_version,
             title_generated_from_entry_id, title_updated_at
         ) VALUES (?1, ?2, ?3, ?4, NULL, NULL, 0, ?5, ?6, 'chat', NULL,
                   'placeholder', 0, ?7, NULL, NULL)",
        params![
            session_id,
            cwd,
            now,
            now,
            parent_session_id,
            parent_session_message_id,
            SESSION_TITLE_POLICY_VERSION,
        ],
    )?;
    Ok(())
}

/// Append an entry to a session. Returns the assigned sequence number.
pub(super) fn append_entry(
    conn: &Connection,
    session_id: &str,
    entry: &SessionEntry,
) -> Result<i64> {
    let base = entry.base();
    let entry_type = entry.entry_type();
    let payload = serde_json::to_string(entry)?;
    let timestamp = base.timestamp.to_rfc3339();
    let parent_id = base.parent_id.as_ref().map(|id| id.as_str().to_string());

    let seq: i64 = conn.query_row(
        "SELECT COALESCE(MAX(seq), 0) + 1 FROM entries WHERE session_id = ?1",
        params![session_id],
        |row| row.get(0),
    )?;

    conn.execute(
        "INSERT INTO entries (session_id, seq, entry_id, parent_id, type, timestamp, payload)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            session_id,
            seq,
            base.id.as_str(),
            parent_id,
            entry_type,
            timestamp,
            payload,
        ],
    )?;

    conn.execute(
        "UPDATE sessions SET
            leaf_id = ?1,
            updated_at = ?2,
            entry_count = entry_count + 1
         WHERE session_id = ?3",
        params![base.id.as_str(), timestamp, session_id],
    )?;

    Ok(seq)
}

/// Move the leaf pointer to an earlier entry (branching).
pub(super) fn set_leaf(conn: &Connection, session_id: &str, leaf_id: Option<&str>) -> Result<()> {
    conn.execute(
        "UPDATE sessions SET leaf_id = ?1 WHERE session_id = ?2",
        params![leaf_id, session_id],
    )?;
    Ok(())
}

/// Set or clear the display name for a session.
pub(super) fn set_session_name(
    conn: &Connection,
    session_id: &str,
    name: Option<&str>,
) -> Result<()> {
    let source = if name.is_some() {
        SessionTitleSource::Manual
    } else {
        SessionTitleSource::Placeholder
    };
    set_session_title(conn, session_id, name, source, None)?;
    Ok(())
}

pub(super) fn set_session_title(
    conn: &Connection,
    session_id: &str,
    name: Option<&str>,
    source: SessionTitleSource,
    generated_from_entry_id: Option<&str>,
) -> Result<bool> {
    let normalized_name = name.map(str::trim).filter(|value| !value.is_empty());
    let incoming_source = if normalized_name.is_some() {
        source
    } else {
        SessionTitleSource::Placeholder
    };
    let existing = conn.query_row(
        "SELECT name, title_source, title_revision FROM sessions WHERE session_id = ?1",
        params![session_id],
        |row| {
            Ok((
                row.get::<_, Option<String>>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        },
    );
    let (existing_name, existing_source_raw, existing_revision) = match existing {
        Ok(value) => value,
        Err(rusqlite::Error::QueryReturnedNoRows) => return Ok(false),
        Err(error) => return Err(error.into()),
    };
    let existing_source = SessionTitleSource::from_db(&existing_source_raw);
    let title_changed = existing_name.as_deref() != normalized_name;

    let legacy_is_known_auto = existing_source == SessionTitleSource::Legacy
        && existing_name
            .as_deref()
            .is_some_and(crate::naming::is_known_legacy_auto_title);
    let allowed = match incoming_source {
        SessionTitleSource::Placeholder => {
            existing_source == SessionTitleSource::Placeholder || legacy_is_known_auto
        }
        SessionTitleSource::Auto => {
            existing_source == SessionTitleSource::Placeholder
                || (existing_source == SessionTitleSource::Auto
                    && existing_revision < 2
                    && title_changed)
                || legacy_is_known_auto
        }
        _ => existing_source.can_be_replaced_by(incoming_source),
    };
    if !allowed {
        return Ok(false);
    }

    if !title_changed && existing_source == incoming_source {
        return Ok(false);
    }
    let next_revision = if incoming_source == SessionTitleSource::Placeholder {
        0
    } else if incoming_source == SessionTitleSource::Auto
        && existing_source == SessionTitleSource::Auto
    {
        (existing_revision + 1).min(2)
    } else if existing_source == incoming_source {
        existing_revision + 1
    } else {
        1
    };
    let title_updated_at = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE sessions
         SET name = ?1,
             title_source = ?2,
             title_revision = ?3,
             title_policy_version = ?4,
             title_generated_from_entry_id = ?5,
             title_updated_at = ?6,
             updated_at = ?6
         WHERE session_id = ?7",
        params![
            normalized_name,
            incoming_source.as_str(),
            next_revision,
            SESSION_TITLE_POLICY_VERSION,
            generated_from_entry_id,
            title_updated_at,
            session_id,
        ],
    )?;
    Ok(true)
}

pub(super) fn update_session_scope(
    conn: &Connection,
    session_id: &str,
    session_scope: &str,
    cwd: &str,
    project_root: Option<&str>,
) -> Result<()> {
    conn.execute(
        "UPDATE sessions
         SET session_scope = ?1,
             cwd = ?2,
             project_root = ?3,
             updated_at = datetime('now')
         WHERE session_id = ?4",
        params![session_scope, cwd, project_root, session_id],
    )?;
    Ok(())
}

pub(super) fn upsert_project(
    conn: &Connection,
    project_id: &str,
    root: &str,
    name: Option<&str>,
) -> Result<()> {
    let trimmed_name = name.map(str::trim).filter(|value| !value.is_empty());
    conn.execute(
        "INSERT INTO projects (project_id, root, name, created_at, updated_at, archived_at)
         VALUES (?1, ?2, ?3, datetime('now'), datetime('now'), NULL)
         ON CONFLICT(root) DO UPDATE SET
             project_id = excluded.project_id,
             name = COALESCE(excluded.name, projects.name),
             updated_at = datetime('now'),
             archived_at = NULL",
        params![project_id, root, trimmed_name],
    )?;
    Ok(())
}

pub(super) fn delete_session(conn: &Connection, session_id: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM entries WHERE session_id = ?1",
        params![session_id],
    )?;
    conn.execute(
        "DELETE FROM sessions WHERE session_id = ?1",
        params![session_id],
    )?;
    Ok(())
}
