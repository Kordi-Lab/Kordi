use anyhow::Result;
use rusqlite::Connection;
use std::time::Duration;

const CURRENT_VERSION: i32 = 10;
pub(crate) const SQLITE_BUSY_TIMEOUT: Duration = Duration::from_secs(5);

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

const MIGRATION_V10: &str = r#"
ALTER TABLE sessions ADD COLUMN title_source TEXT NOT NULL DEFAULT 'placeholder';
ALTER TABLE sessions ADD COLUMN title_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN title_policy_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE sessions ADD COLUMN title_generated_from_entry_id TEXT;
ALTER TABLE sessions ADD COLUMN title_updated_at TEXT;

UPDATE sessions
SET title_source = 'legacy',
    title_revision = 1,
    title_updated_at = updated_at
WHERE name IS NOT NULL
  AND TRIM(name) <> '';

UPDATE sessions
SET name = NULL,
    title_source = 'placeholder',
    title_revision = 0,
    title_updated_at = NULL
WHERE name IS NULL
   OR TRIM(name) = ''
   OR LOWER(TRIM(name)) IN (
       'new session', 'new chat', 'untitled session', 'session',
       'hi', 'hii', 'hiii', 'hiiii', 'hello', 'hey', 'test', 'testing',
       'test reply', 'ok', 'okay', 'thanks', 'thank you', 'got it',
       'hi how are you', 'hello how are you', 'how are you'
   )
   OR TRIM(name) IN ('你好', '您好', '嗨', '测试', '收到', '好的', '谢谢')
   OR TRIM(name) = session_id
   OR LOWER(TRIM(name)) LIKE 'session:%'
   OR TRIM(name) = 'Session ' || SUBSTR(session_id, 1, 8)
   OR (
       LENGTH(TRIM(name)) = 36
       AND SUBSTR(TRIM(name), 9, 1) = '-'
       AND SUBSTR(TRIM(name), 14, 1) = '-'
       AND SUBSTR(TRIM(name), 19, 1) = '-'
       AND SUBSTR(TRIM(name), 24, 1) = '-'
       AND LOWER(REPLACE(TRIM(name), '-', '')) NOT GLOB '*[^0-9a-f]*'
   )
   OR LOWER(REPLACE(TRIM(name), ' ', '')) IN ('@mykordi', '@myagent', '@kordi')
   OR (
       LOWER(REPLACE(TRIM(name), ' ', '')) LIKE 'testreply%'
       AND SUBSTR(LOWER(REPLACE(TRIM(name), ' ', '')), 10) NOT GLOB '*[^0-9]*'
   )
   OR TRIM(name) NOT GLOB '*[^0-9]*';
"#;

/// Initialize database schema, applying migrations as needed.
pub fn init_schema(conn: &Connection) -> Result<()> {
    conn.busy_timeout(SQLITE_BUSY_TIMEOUT)?;

    // Opening an already-migrated database is the hot path. Avoid taking a
    // write lock unless this connection can see pending schema work.
    if get_version(conn) >= CURRENT_VERSION {
        return Ok(());
    }

    // Multiple desktop startup paths may open a brand-new session database at
    // the same time. Serialize the complete read-migrate-record sequence so a
    // second connection re-checks the version after the first one commits.
    conn.execute_batch("BEGIN IMMEDIATE;")?;
    let result = apply_pending_migrations(conn);
    match result {
        Ok(()) => {
            if let Err(error) = conn.execute_batch("COMMIT;") {
                let _ = conn.execute_batch("ROLLBACK;");
                return Err(error.into());
            }
            Ok(())
        }
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK;");
            Err(error)
        }
    }
}

fn apply_pending_migrations(conn: &Connection) -> Result<()> {
    let current = get_version(conn);

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

    if current < 10 {
        conn.execute_batch(MIGRATION_V10)?;
        set_version(conn, 10)?;
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

fn get_version(conn: &Connection) -> i32 {
    // Table may not exist yet
    let result = conn.query_row(
        "SELECT COALESCE(MAX(version), 0) FROM schema_version",
        [],
        |row| row.get::<_, i32>(0),
    );
    result.unwrap_or(0)
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

    #[test]
    fn test_init_schema() {
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        assert_eq!(get_version(&conn), CURRENT_VERSION);

        // Idempotent
        init_schema(&conn).unwrap();
        assert_eq!(get_version(&conn), CURRENT_VERSION);

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
        assert!(columns.contains(&"title_source".to_string()));
        assert!(columns.contains(&"title_revision".to_string()));
        assert!(columns.contains(&"title_policy_version".to_string()));
        assert!(columns.contains(&"title_generated_from_entry_id".to_string()));
        assert!(columns.contains(&"title_updated_at".to_string()));

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
    fn v10_migration_preserves_substantive_legacy_names_and_clears_weak_titles() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA_V1).unwrap();
        set_version(&conn, 1).unwrap();
        conn.execute_batch(MIGRATION_V2).unwrap();
        set_version(&conn, 2).unwrap();
        conn.execute_batch(MIGRATION_V3).unwrap();
        set_version(&conn, 3).unwrap();
        conn.execute_batch(MIGRATION_V4).unwrap();
        set_version(&conn, 4).unwrap();
        conn.execute_batch(MIGRATION_V5).unwrap();
        set_version(&conn, 5).unwrap();
        set_version(&conn, 6).unwrap();
        conn.execute_batch(MIGRATION_V7).unwrap();
        set_version(&conn, 7).unwrap();
        conn.execute_batch(MIGRATION_V8).unwrap();
        set_version(&conn, 8).unwrap();
        conn.execute_batch(MIGRATION_V9).unwrap();
        set_version(&conn, 9).unwrap();
        conn.execute(
            "INSERT INTO sessions(session_id, cwd, created_at, updated_at, name, entry_count, session_scope) VALUES(?1, '.', '2026-07-15T00:00:00Z', '2026-07-15T00:00:00Z', ?2, 0, 'chat')",
            rusqlite::params!["meaningful", "Release validation plan"],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sessions(session_id, cwd, created_at, updated_at, name, entry_count, session_scope) VALUES(?1, '.', '2026-07-15T00:00:00Z', '2026-07-15T00:00:00Z', ?2, 0, 'chat')",
            rusqlite::params!["weak", "hello"],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sessions(session_id, cwd, created_at, updated_at, name, entry_count, session_scope) VALUES(?1, '.', '2026-07-15T00:00:00Z', '2026-07-15T00:00:00Z', ?2, 0, 'chat')",
            rusqlite::params!["raw-id", "e2b79cd7-70c0-4cee-ae1b-9bc8cb28da83"],
        )
        .unwrap();

        init_schema(&conn).unwrap();

        let meaningful: (Option<String>, String) = conn
            .query_row(
                "SELECT name, title_source FROM sessions WHERE session_id = 'meaningful'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        let weak: (Option<String>, String) = conn
            .query_row(
                "SELECT name, title_source FROM sessions WHERE session_id = 'weak'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        let raw_id: (Option<String>, String) = conn
            .query_row(
                "SELECT name, title_source FROM sessions WHERE session_id = 'raw-id'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            meaningful,
            (
                Some("Release validation plan".to_string()),
                "legacy".to_string()
            )
        );
        assert_eq!(weak, (None, "placeholder".to_string()));
        assert_eq!(raw_id, (None, "placeholder".to_string()));
    }
}
