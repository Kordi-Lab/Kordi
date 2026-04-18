pub mod auth;
pub mod endpoints;
pub mod invites;
pub mod keys;
pub mod projects;
pub mod relay;
pub mod skills;

use axum::extract::ws::Message;
use axum::Router;
use rusqlite::Connection;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};
use tower_http::cors::{Any, CorsLayer};

use crate::error::ServerInitError;

/// Shared state for all server routes.
pub struct ServerState {
    pub db_path: PathBuf,
    pub derp_clients: Mutex<HashMap<String, mpsc::UnboundedSender<Message>>>,
}

impl ServerState {
    pub fn new(db_path: PathBuf) -> Self {
        Self {
            db_path,
            derp_clients: Mutex::new(HashMap::new()),
        }
    }

    pub fn open_connection(&self) -> Result<Connection, rusqlite::Error> {
        Connection::open(&self.db_path)
    }
}

#[cfg(test)]
pub fn make_test_state() -> Arc<ServerState> {
    let db_path =
        std::env::temp_dir().join(format!("bridges-serve-test-{}.db", uuid::Uuid::new_v4()));
    let conn = Connection::open(&db_path).unwrap();
    init_server_db(&conn).unwrap();
    drop(conn);
    Arc::new(ServerState::new(db_path))
}

/// Initialize the server database schema.
pub fn init_server_db(conn: &Connection) -> Result<(), ServerInitError> {
    conn.execute_batch(SERVER_SCHEMA)
        .map_err(ServerInitError::Schema)?;

    add_column_if_missing(conn, "registered_nodes", "endpoint_hints", "TEXT")?;
    add_column_if_missing(conn, "registered_nodes", "revoked_at", "TEXT")?;
    add_column_if_missing(conn, "registered_nodes", "revocation_reason", "TEXT")?;
    add_column_if_missing(conn, "registered_nodes", "replacement_node_id", "TEXT")?;

    migrate_registered_nodes_to_core(conn)?;
    migrate_server_projects_to_core(conn)?;
    remove_legacy_user_state(conn)?;
    Ok(())
}

fn add_column_if_missing(
    conn: &Connection,
    table: &'static str,
    column: &'static str,
    column_type: &'static str,
) -> Result<(), ServerInitError> {
    let sql = format!("ALTER TABLE {table} ADD COLUMN {column} {column_type}");
    if let Err(source) = conn.execute(&sql, []) {
        let msg = source.to_string();
        if !msg.contains("duplicate column name") {
            return Err(ServerInitError::AddColumn {
                table,
                column,
                source,
            });
        }
    }
    Ok(())
}

fn table_has_column(conn: &Connection, table: &str, column: &str) -> Result<bool, ServerInitError> {
    let sql = format!("PRAGMA table_info({table})");
    let mut stmt = conn
        .prepare(&sql)
        .map_err(ServerInitError::PrepareTableInfo)?;
    let has_column = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(ServerInitError::QueryTableInfo)?
        .filter_map(Result::ok)
        .any(|name| name == column);
    Ok(has_column)
}

fn migrate_registered_nodes_to_core(conn: &Connection) -> Result<(), ServerInitError> {
    let needs_migration = table_has_column(conn, "registered_nodes", "gitea_user")?
        || table_has_column(conn, "registered_nodes", "user_id")?;
    if !needs_migration {
        return Ok(());
    }

    conn.execute_batch(
        r#"
        DROP TABLE IF EXISTS registered_nodes_new;
        CREATE TABLE registered_nodes_new (
            node_id             TEXT PRIMARY KEY,
            ed25519_pubkey      TEXT NOT NULL,
            x25519_pubkey       TEXT NOT NULL,
            display_name        TEXT,
            owner_name          TEXT,
            api_key_hash        TEXT NOT NULL,
            endpoint_hints      TEXT,
            revoked_at          TEXT,
            revocation_reason   TEXT,
            replacement_node_id TEXT,
            created_at          TEXT NOT NULL
        );

        INSERT INTO registered_nodes_new (
            node_id,
            ed25519_pubkey,
            x25519_pubkey,
            display_name,
            owner_name,
            api_key_hash,
            endpoint_hints,
            revoked_at,
            revocation_reason,
            replacement_node_id,
            created_at
        )
        SELECT
            node_id,
            ed25519_pubkey,
            x25519_pubkey,
            display_name,
            owner_name,
            api_key_hash,
            endpoint_hints,
            revoked_at,
            revocation_reason,
            replacement_node_id,
            created_at
        FROM registered_nodes;

        DROP TABLE registered_nodes;
        ALTER TABLE registered_nodes_new RENAME TO registered_nodes;
        "#,
    )
    .map_err(ServerInitError::RegisteredNodesMigration)
}

fn migrate_server_projects_to_core(conn: &Connection) -> Result<(), ServerInitError> {
    let needs_migration = table_has_column(conn, "server_projects", "gitea_owner")?
        || table_has_column(conn, "server_projects", "gitea_repo")?;
    if !needs_migration {
        return Ok(());
    }

    conn.execute_batch(
        r#"
        DROP TABLE IF EXISTS server_projects_new;
        CREATE TABLE server_projects_new (
            project_id      TEXT PRIMARY KEY,
            slug            TEXT UNIQUE NOT NULL,
            display_name    TEXT,
            description     TEXT,
            created_by      TEXT NOT NULL,
            created_at      TEXT NOT NULL
        );

        INSERT INTO server_projects_new (
            project_id,
            slug,
            display_name,
            description,
            created_by,
            created_at
        )
        SELECT
            project_id,
            slug,
            display_name,
            description,
            created_by,
            created_at
        FROM server_projects;

        DROP TABLE server_projects;
        ALTER TABLE server_projects_new RENAME TO server_projects;
        "#,
    )
    .map_err(ServerInitError::ServerProjectsMigration)
}

fn remove_legacy_user_state(conn: &Connection) -> Result<(), ServerInitError> {
    conn.execute_batch(
        r#"
        DROP INDEX IF EXISTS idx_user_tokens_hash;
        DROP INDEX IF EXISTS idx_user_tokens_user;
        DROP INDEX IF EXISTS idx_nodes_user;
        DROP TABLE IF EXISTS user_contacts;
        DROP TABLE IF EXISTS user_tokens;
        DROP TABLE IF EXISTS password_reset_tokens;
        DROP TABLE IF EXISTS users;
        "#,
    )
    .map_err(ServerInitError::RemoveLegacyUserState)
}

/// Build the full axum router for `bridges serve`.
pub fn router(state: Arc<ServerState>) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    Router::new()
        .merge(auth::routes(state.clone()))
        .merge(keys::routes(state.clone()))
        .merge(endpoints::routes(state.clone()))
        .merge(projects::routes(state.clone()))
        .merge(skills::routes(state.clone()))
        .merge(relay::routes(state.clone()))
        .route("/health", axum::routing::get(health))
        .layer(cors)
}

async fn health() -> axum::Json<serde_json::Value> {
    axum::Json(serde_json::json!({ "ok": true }))
}

/// Start the coordination server.
pub async fn run(port: u16, db_path: &str) -> Result<(), String> {
    let conn = Connection::open(db_path).map_err(|e| format!("open db: {}", e))?;
    init_server_db(&conn).map_err(|e| e.to_string())?;
    drop(conn);

    let state = Arc::new(ServerState::new(Path::new(db_path).to_path_buf()));
    let app = router(state);
    let addr = format!("0.0.0.0:{}", port);
    println!("Bridges coordination server on {}", addr);
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .map_err(|e| format!("bind: {}", e))?;
    axum::serve(listener, app)
        .await
        .map_err(|e| format!("serve: {}", e))
}

const SERVER_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS registered_nodes (
    node_id             TEXT PRIMARY KEY,
    ed25519_pubkey      TEXT NOT NULL,
    x25519_pubkey       TEXT NOT NULL,
    display_name        TEXT,
    owner_name          TEXT,
    api_key_hash        TEXT NOT NULL,
    endpoint_hints      TEXT,
    revoked_at          TEXT,
    revocation_reason   TEXT,
    replacement_node_id TEXT,
    created_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS server_projects (
    project_id      TEXT PRIMARY KEY,
    slug            TEXT UNIQUE NOT NULL,
    display_name    TEXT,
    description     TEXT,
    created_by      TEXT NOT NULL,
    created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS server_members (
    project_id      TEXT NOT NULL,
    node_id         TEXT NOT NULL,
    agent_role      TEXT,
    joined_at       TEXT NOT NULL,
    PRIMARY KEY (project_id, node_id)
);

CREATE TABLE IF NOT EXISTS server_invites (
    invite_id       TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL,
    token_hash      TEXT NOT NULL,
    created_by      TEXT NOT NULL,
    max_uses        INTEGER,
    use_count       INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS server_skills (
    skill_id        TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL,
    node_id         TEXT NOT NULL,
    name            TEXT NOT NULL,
    description     TEXT,
    created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS server_mailbox (
    message_id      TEXT PRIMARY KEY,
    target_node_id  TEXT NOT NULL,
    from_node_id    TEXT NOT NULL,
    blob            TEXT NOT NULL,
    project_id      TEXT,
    created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_server_mailbox_target_created
    ON server_mailbox (target_node_id, created_at);
"#;
