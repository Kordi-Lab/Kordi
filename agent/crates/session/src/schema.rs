use anyhow::Result;
use rusqlite::Connection;

#[cfg(test)]
const CURRENT_VERSION: i32 = 8;

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

/// Initialize database schema, applying migrations as needed.
pub fn init_schema(conn: &Connection) -> Result<()> {
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
}
