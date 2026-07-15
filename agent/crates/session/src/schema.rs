use anyhow::{Context, Result};
use rusqlite::{Connection, Transaction, TransactionBehavior};

#[cfg(test)]
const CURRENT_VERSION: i32 = 9;

const SCHEMA_V1: &str = r#"
CREATE TABLE IF NOT EXISTS entries (
    session_id TEXT    NOT NULL,
    seq        INTEGER NOT NULL,
    entry_id   TEXT    NOT NULL,
    parent_id  TEXT,
    type       TEXT    NOT NULL,
    timestamp  TEXT    NOT NULL,
    payload    TEXT    NOT NULL,
    PRIMARY KEY (session_id, seq)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_entry_id
    ON entries(session_id, entry_id);

CREATE INDEX IF NOT EXISTS idx_entry_parent
    ON entries(session_id, parent_id);

CREATE TABLE IF NOT EXISTS sessions (
    session_id  TEXT PRIMARY KEY,
    cwd         TEXT    NOT NULL,
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL,
    name        TEXT,
    leaf_id     TEXT,
    entry_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_sessions_cwd
    ON sessions(cwd);

CREATE TABLE IF NOT EXISTS schema_version (
    version    INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
);
"#;

const MIGRATION_V2: &str = r#"
ALTER TABLE sessions ADD COLUMN parent_session_id TEXT;
CREATE INDEX IF NOT EXISTS idx_sessions_parent_session
    ON sessions(parent_session_id);
"#;

const MIGRATION_V3: &str = r#"
ALTER TABLE sessions ADD COLUMN session_scope TEXT NOT NULL DEFAULT 'chat';
ALTER TABLE sessions ADD COLUMN project_root TEXT;
CREATE INDEX IF NOT EXISTS idx_sessions_scope
    ON sessions(session_scope);
CREATE INDEX IF NOT EXISTS idx_sessions_project_root
    ON sessions(project_root);
"#;

const MIGRATION_V4: &str = r#"
CREATE TABLE IF NOT EXISTS projects (
    project_id  TEXT PRIMARY KEY,
    root        TEXT NOT NULL UNIQUE,
    name        TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    archived_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_projects_root
    ON projects(root);
CREATE INDEX IF NOT EXISTS idx_projects_archived_at
    ON projects(archived_at);
"#;

const MIGRATION_V5: &str = r#"
CREATE TABLE IF NOT EXISTS reflection_lessons (
    lesson_id     TEXT PRIMARY KEY,
    scope         TEXT NOT NULL,
    scope_id      TEXT NOT NULL,
    artifact_path TEXT NOT NULL,
    source        TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    archived_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_reflection_lessons_scope
    ON reflection_lessons(scope, scope_id, archived_at);
CREATE INDEX IF NOT EXISTS idx_reflection_lessons_updated_at
    ON reflection_lessons(updated_at);
"#;

const MIGRATION_V7: &str = r#"
CREATE TABLE IF NOT EXISTS tasks (
    task_id                    TEXT PRIMARY KEY,
    title                      TEXT NOT NULL,
    summary                    TEXT,
    status                     TEXT NOT NULL DEFAULT 'open',
    involved_participants_json TEXT NOT NULL DEFAULT '[]',
    created_at                 TEXT NOT NULL,
    updated_at                 TEXT NOT NULL,
    closed_at                  TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_status_updated
    ON tasks(status, updated_at DESC);
"#;

const MIGRATION_V8: &str = r#"
ALTER TABLE tasks RENAME TO tasks_v7_legacy;
CREATE TABLE tasks (
    session_id                 TEXT NOT NULL,
    task_id                    TEXT NOT NULL,
    parent_task_id             TEXT,
    title                      TEXT NOT NULL,
    summary                    TEXT,
    status                     TEXT NOT NULL DEFAULT 'open',
    involved_participants_json TEXT NOT NULL DEFAULT '[]',
    created_at                 TEXT NOT NULL,
    updated_at                 TEXT NOT NULL,
    closed_at                  TEXT,
    PRIMARY KEY (session_id, task_id)
);
INSERT INTO tasks (
    session_id, task_id, parent_task_id, title, summary, status,
    involved_participants_json, created_at, updated_at, closed_at
)
SELECT '', task_id, NULL, title, summary, status,
       involved_participants_json, created_at, updated_at, closed_at
FROM tasks_v7_legacy;
DROP TABLE tasks_v7_legacy;
CREATE INDEX IF NOT EXISTS idx_tasks_status_updated
    ON tasks(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_session_status_updated
    ON tasks(session_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_session_parent
    ON tasks(session_id, parent_task_id);
"#;

const MIGRATION_V9: &str = r#"
ALTER TABLE sessions ADD COLUMN parent_session_message_id TEXT;
"#;

/// Initialize database schema, applying migrations as needed.
pub fn init_schema(conn: &Connection) -> Result<()> {
    // Acquire the write reservation before reading the current version. Without
    // this boundary, two connections opening a new database can both observe
    // the same version and race the DDL and schema_version insertions below.
    let transaction = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)
        .context("acquiring the session schema migration write lock")?;
    apply_migrations(&transaction).context("applying session schema migrations")?;
    transaction
        .commit()
        .context("committing session schema migrations")?;
    Ok(())
}

fn apply_migrations(conn: &Connection) -> Result<()> {
    let current = get_version(conn)?;

    if current < 1 {
        conn.execute_batch(SCHEMA_V1)?;
        set_version(conn, 1)?;
    }

    if current < 2 {
        conn.execute_batch(MIGRATION_V2)?;
        set_version(conn, 2)?;
    }

    if current < 3 {
        conn.execute_batch(MIGRATION_V3)?;
        set_version(conn, 3)?;
    }

    if current < 4 {
        conn.execute_batch(MIGRATION_V4)?;
        set_version(conn, 4)?;
    }

    if current < 5 {
        conn.execute_batch(MIGRATION_V5)?;
        set_version(conn, 5)?;
    }

    if current < 6 {
        migrate_reflection_lessons_to_artifact_paths(conn)?;
        set_version(conn, 6)?;
    }

    if current < 7 {
        conn.execute_batch(MIGRATION_V7)?;
        set_version(conn, 7)?;
    }

    if current < 8 {
        conn.execute_batch(MIGRATION_V8)?;
        set_version(conn, 8)?;
    }

    if current < 9 {
        conn.execute_batch(MIGRATION_V9)?;
        set_version(conn, 9)?;
    }

    Ok(())
}

fn table_exists(conn: &Connection, table_name: &str) -> Result<bool> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
        [table_name],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

fn table_columns(conn: &Connection, table_name: &str) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table_name})"))?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;
    let mut columns = Vec::new();
    for row in rows {
        columns.push(row?);
    }
    Ok(columns)
}

fn migrate_reflection_lessons_to_artifact_paths(conn: &Connection) -> Result<()> {
    if !table_exists(conn, "reflection_lessons")? {
        conn.execute_batch(MIGRATION_V5)?;
        return Ok(());
    }

    let columns = table_columns(conn, "reflection_lessons")?;
    if !columns.iter().any(|column| column == "lesson") {
        return Ok(());
    }

    let old_has_artifact_path = columns.iter().any(|column| column == "artifact_path");
    conn.execute_batch(
        "ALTER TABLE reflection_lessons RENAME TO reflection_lessons_prompt_lessons_v5;",
    )?;
    conn.execute_batch(MIGRATION_V5)?;
    if old_has_artifact_path {
        conn.execute_batch(
            "INSERT INTO reflection_lessons (
                 lesson_id, scope, scope_id, artifact_path, source, created_at, updated_at, archived_at
             )
             SELECT lesson_id, scope, scope_id, COALESCE(artifact_path, ''), source, created_at, updated_at, archived_at
             FROM reflection_lessons_prompt_lessons_v5
             WHERE COALESCE(artifact_path, '') <> '';",
        )?;
    }
    conn.execute_batch("DROP TABLE reflection_lessons_prompt_lessons_v5;")?;
    Ok(())
}

fn get_version(conn: &Connection) -> Result<i32> {
    if !table_exists(conn, "schema_version")? {
        return Ok(0);
    }

    Ok(conn.query_row(
        "SELECT COALESCE(MAX(version), 0) FROM schema_version",
        [],
        |row| row.get::<_, i32>(0),
    )?)
}

fn set_version(conn: &Connection, version: i32) -> Result<()> {
    conn.execute(
        "INSERT INTO schema_version (version, applied_at) VALUES (?1, datetime('now'))",
        rusqlite::params![version],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        Arc, Barrier,
        atomic::{AtomicBool, Ordering},
    };
    use std::thread;
    use std::time::{Duration, Instant};

    static CONTENDER_WAITING_FOR_WRITE: AtomicBool = AtomicBool::new(false);

    fn record_busy_wait(_attempts: i32) -> bool {
        CONTENDER_WAITING_FOR_WRITE.store(true, Ordering::SeqCst);
        thread::yield_now();
        true
    }

    #[test]
    fn test_init_schema() {
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        assert_eq!(get_version(&conn).unwrap(), CURRENT_VERSION);

        // Idempotent
        init_schema(&conn).unwrap();
        assert_eq!(get_version(&conn).unwrap(), CURRENT_VERSION);

        let mut stmt = conn.prepare("PRAGMA table_info(sessions)").unwrap();
        let columns: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .collect::<std::result::Result<Vec<_>, _>>()
            .unwrap();
        assert!(columns.contains(&"parent_session_id".to_string()));
        assert!(columns.contains(&"parent_session_message_id".to_string()));
        assert!(columns.contains(&"session_scope".to_string()));
        assert!(columns.contains(&"project_root".to_string()));

        let project_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'projects'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(project_count, 1);

        let reflection_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'reflection_lessons'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(reflection_count, 1);
    }

    #[test]
    fn initialized_file_database_reopens_without_reapplying_migrations() {
        let temp_dir = tempfile::tempdir().unwrap();
        let db_path = temp_dir.path().join("sessions.db");

        let session_id = {
            let conn = crate::store::open_db(&db_path).unwrap();
            let journal_mode: String = conn
                .query_row("PRAGMA journal_mode", [], |row| row.get(0))
                .unwrap();
            let foreign_keys: i64 = conn
                .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
                .unwrap();
            let busy_timeout_ms: i64 = conn
                .query_row("PRAGMA busy_timeout", [], |row| row.get(0))
                .unwrap();

            assert!(journal_mode.eq_ignore_ascii_case("wal"));
            assert_eq!(foreign_keys, 1);
            assert_eq!(busy_timeout_ms, 5_000);
            crate::store::create_session(&conn, "/tmp/kordi").unwrap()
        };

        let conn = crate::store::open_db(&db_path).unwrap();
        assert_eq!(get_version(&conn).unwrap(), CURRENT_VERSION);
        let applied_versions: i64 = conn
            .query_row("SELECT COUNT(*) FROM schema_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(applied_versions, i64::from(CURRENT_VERSION));

        let restored = crate::store::get_session(&conn, &session_id)
            .unwrap()
            .expect("session data should survive an idempotent reopen");
        assert_eq!(restored.cwd, "/tmp/kordi");
    }

    #[test]
    fn failed_migration_rolls_back_the_entire_sequence() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA_V1).unwrap();
        set_version(&conn, 1).unwrap();

        // Force migration 3 to fail after migration 2 has already changed the
        // schema and recorded its version inside the migration transaction.
        conn.execute_batch(
            "ALTER TABLE sessions ADD COLUMN session_scope TEXT NOT NULL DEFAULT 'chat';",
        )
        .unwrap();

        let error = init_schema(&conn).unwrap_err();
        let error_chain = format!("{error:#}");
        assert!(error_chain.contains("applying session schema migrations"));
        assert!(error_chain.contains("duplicate column name: session_scope"));
        assert_eq!(get_version(&conn).unwrap(), 1);

        let columns = table_columns(&conn, "sessions").unwrap();
        assert!(columns.contains(&"session_scope".to_string()));
        assert!(!columns.contains(&"parent_session_id".to_string()));
    }

    #[test]
    fn concurrent_init_rechecks_version_after_acquiring_write_lock() {
        let temp_dir = tempfile::tempdir().unwrap();
        let db_path = temp_dir.path().join("sessions.db");
        let primary = Connection::open(&db_path).unwrap();
        let primary_transaction =
            Transaction::new_unchecked(&primary, TransactionBehavior::Immediate).unwrap();

        CONTENDER_WAITING_FOR_WRITE.store(false, Ordering::SeqCst);
        let contender_path = db_path.clone();
        let contender = thread::spawn(move || {
            let conn = Connection::open(contender_path).unwrap();
            conn.busy_handler(Some(record_busy_wait)).unwrap();
            init_schema(&conn)
        });

        let deadline = Instant::now() + Duration::from_secs(5);
        while !CONTENDER_WAITING_FOR_WRITE.load(Ordering::SeqCst) {
            assert!(
                Instant::now() < deadline,
                "contending schema initialization did not wait for the write lock"
            );
            thread::yield_now();
        }

        apply_migrations(&primary_transaction).unwrap();
        primary_transaction.commit().unwrap();
        contender.join().unwrap().unwrap();

        let conn = Connection::open(&db_path).unwrap();
        assert_eq!(get_version(&conn).unwrap(), CURRENT_VERSION);
        let applied_versions: i64 = conn
            .query_row("SELECT COUNT(*) FROM schema_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(applied_versions, i64::from(CURRENT_VERSION));
    }

    #[test]
    fn concurrent_first_time_opens_all_succeed() {
        const CONCURRENT_OPENS: usize = 12;

        let temp_dir = tempfile::tempdir().unwrap();
        let db_path = temp_dir.path().join("sessions.db");
        let start = Arc::new(Barrier::new(CONCURRENT_OPENS));
        let handles: Vec<_> = (0..CONCURRENT_OPENS)
            .map(|_| {
                let db_path = db_path.clone();
                let start = Arc::clone(&start);
                thread::spawn(move || {
                    start.wait();
                    crate::store::open_db(&db_path)
                        .map(drop)
                        .map_err(|error| error.to_string())
                })
            })
            .collect();

        for handle in handles {
            handle.join().unwrap().unwrap();
        }

        let conn = crate::store::open_db(&db_path).unwrap();
        assert_eq!(get_version(&conn).unwrap(), CURRENT_VERSION);
        let (applied_versions, distinct_versions): (i64, i64) = conn
            .query_row(
                "SELECT COUNT(*), COUNT(DISTINCT version) FROM schema_version",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(applied_versions, i64::from(CURRENT_VERSION));
        assert_eq!(distinct_versions, i64::from(CURRENT_VERSION));
        let integrity_check: String = conn
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))
            .unwrap();
        assert_eq!(integrity_check, "ok");
    }
}
