use anyhow::{Context, Result, bail};
use chrono::Utc;
use kordi_core::types::SessionEntry;
use rusqlite::{Connection, ErrorCode, params};
use std::thread;
use std::time::{Duration, Instant};
use uuid::Uuid;

use crate::schema;

const SESSION_DB_BUSY_TIMEOUT: Duration = Duration::from_secs(5);
const SESSION_DB_BUSY_RETRY_INTERVAL: Duration = Duration::from_millis(10);

/// Open or create the sessions database.
pub(super) fn open_db(path: &std::path::Path) -> Result<Connection> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let conn = Connection::open(path)?;
    conn.busy_timeout(SESSION_DB_BUSY_TIMEOUT)
        .context("configuring the session database busy timeout")?;
    conn.execute_batch("PRAGMA foreign_keys=ON;")
        .context("enabling session database foreign keys")?;
    enable_wal_mode(&conn)?;
    schema::init_schema(&conn).context("initializing the session database schema")?;
    Ok(conn)
}

fn enable_wal_mode(conn: &Connection) -> Result<()> {
    let deadline = Instant::now() + SESSION_DB_BUSY_TIMEOUT;
    loop {
        match conn.query_row("PRAGMA journal_mode=WAL", [], |row| row.get::<_, String>(0)) {
            Ok(mode) if mode.eq_ignore_ascii_case("wal") => return Ok(()),
            Ok(mode) => bail!("SQLite refused WAL mode and kept journal mode {mode}"),
            Err(error) if is_database_contention(&error) && Instant::now() < deadline => {
                // SQLite can return SQLITE_BUSY immediately while another new
                // connection is changing journal mode, without invoking the
                // configured busy handler. Retry within the same bounded wait.
                thread::sleep(SESSION_DB_BUSY_RETRY_INTERVAL);
            }
            Err(error) => return Err(error).context("enabling session database WAL mode"),
        }
    }
}

fn is_database_contention(error: &rusqlite::Error) -> bool {
    matches!(
        error.sqlite_error_code(),
        Some(ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked)
    )
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
             parent_session_id, parent_session_message_id, session_scope, project_root
         ) VALUES (?1, ?2, ?3, ?4, NULL, NULL, 0, ?5, ?6, 'chat', NULL)",
        params![
            session_id,
            cwd,
            now,
            now,
            parent_session_id,
            parent_session_message_id
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
    conn.execute(
        "UPDATE sessions SET name = ?1, updated_at = datetime('now') WHERE session_id = ?2",
        params![name, session_id],
    )?;
    Ok(())
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
