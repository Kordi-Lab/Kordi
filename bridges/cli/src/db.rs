use rusqlite::Connection;
use std::path::PathBuf;

use crate::error::DbError;

/// Default database path: ~/.bridges/bridges.db
pub fn default_db_path() -> Result<PathBuf, DbError> {
    let base = directories::BaseDirs::new().ok_or(DbError::HomeDirUnavailable)?;
    Ok(base.home_dir().join(".bridges").join("bridges.db"))
}

/// Open (or create) the database at the default path.
pub fn open_db() -> Result<Connection, DbError> {
    let path = default_db_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|source| DbError::CreateDir {
            path: parent.to_path_buf(),
            source,
        })?;
    }
    Connection::open(&path).map_err(|source| DbError::Open { path, source })
}

/// Run all schema migrations.
pub fn init_db(conn: &Connection) -> Result<(), DbError> {
    conn.execute_batch(SCHEMA).map_err(DbError::Migrate)
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS nodes (
    node_id             TEXT PRIMARY KEY,
    display_name        TEXT,
    runtime             TEXT,
    endpoint            TEXT,
    public_key          TEXT NOT NULL,
    owner_principal_id  TEXT,
    created_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS peers (
    node_id             TEXT PRIMARY KEY,
    display_name        TEXT,
    runtime             TEXT,
    endpoint            TEXT,
    public_key          TEXT,
    owner_name          TEXT,
    trust_status        TEXT NOT NULL DEFAULT 'pending',
    last_seen_at        TEXT,
    created_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS principals (
    principal_id        TEXT PRIMARY KEY,
    display_name        TEXT,
    email               TEXT,
    created_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
    project_id          TEXT PRIMARY KEY,
    slug                TEXT UNIQUE NOT NULL,
    display_name        TEXT,
    description         TEXT,
    project_path        TEXT,
    owner_principal_id  TEXT,
    status              TEXT NOT NULL DEFAULT 'active',
    created_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_agents (
    project_id          TEXT NOT NULL,
    node_id             TEXT NOT NULL,
    owner_principal_id  TEXT,
    owner_name          TEXT,
    agent_role          TEXT,
    permissions_json    TEXT,
    status              TEXT NOT NULL DEFAULT 'active',
    joined_at           TEXT NOT NULL,
    PRIMARY KEY (project_id, node_id)
);

CREATE TABLE IF NOT EXISTS invites (
    invite_id           TEXT PRIMARY KEY,
    project_id          TEXT NOT NULL,
    token_hash          TEXT NOT NULL,
    created_by          TEXT,
    max_uses            INTEGER,
    use_count           INTEGER NOT NULL DEFAULT 0,
    expires_at          TEXT,
    created_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_skills (
    skill_id            TEXT PRIMARY KEY,
    node_id             TEXT NOT NULL,
    project_id          TEXT NOT NULL,
    name                TEXT NOT NULL,
    description         TEXT,
    created_at          TEXT NOT NULL
);
"#;
