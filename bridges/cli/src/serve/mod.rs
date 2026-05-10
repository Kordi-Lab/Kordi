pub mod auth;
pub mod cloud_auth;
pub mod cloud_auth_routes;
pub mod cloud_password;
pub mod cloud_rate_limit;
pub mod cloud_session;
pub mod contacts;
pub mod db_runner;
pub mod discovery;
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
use std::time::Duration;
use tokio::sync::{mpsc, Mutex};
use tower_http::cors::{Any, CorsLayer};

use crate::error::ServerInitError;

/// Shared state for all server routes.
pub struct ServerState {
    pub db_path: PathBuf,
    pub derp_clients: Mutex<HashMap<String, mpsc::UnboundedSender<Message>>>,
    /// Single-writer SQLite runner used by every cloud-edition handler.
    /// Lazily initialised on first access so existing tests that construct
    /// `ServerState` directly (without going through `run`) still work.
    pub db_runner: tokio::sync::OnceCell<db_runner::DbRunner>,
}

impl ServerState {
    pub fn new(db_path: PathBuf) -> Self {
        Self {
            db_path,
            derp_clients: Mutex::new(HashMap::new()),
            db_runner: tokio::sync::OnceCell::new(),
        }
    }

    pub fn open_connection(&self) -> Result<Connection, rusqlite::Error> {
        let conn = Connection::open(&self.db_path)?;
        configure_server_connection(&conn)?;
        Ok(conn)
    }

    /// Get-or-initialise the shared single-writer runner. The first caller
    /// pays the connection-open cost; subsequent callers reuse the same
    /// `DbRunner`.
    pub async fn db_runner(&self) -> Result<&db_runner::DbRunner, db_runner::DbRunnerError> {
        self.db_runner
            .get_or_try_init(|| async { db_runner::DbRunner::new(self.db_path.clone()) })
            .await
    }
}

pub(crate) fn configure_server_connection(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.busy_timeout(Duration::from_secs(5))?;
    conn.execute_batch(
        "PRAGMA foreign_keys = ON;\n         PRAGMA journal_mode = WAL;\n         PRAGMA synchronous = NORMAL;",
    )?;
    Ok(())
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

    add_column_if_missing(conn, "registered_nodes", "runtime", "TEXT")?;
    add_column_if_missing(conn, "registered_nodes", "human_id", "TEXT")?;
    add_column_if_missing(conn, "registered_nodes", "agent_id", "TEXT")?;
    add_column_if_missing(conn, "registered_nodes", "discovery_mode", "TEXT")?;
    add_column_if_missing(
        conn,
        "registered_nodes",
        "is_default_agent",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    add_column_if_missing(conn, "registered_nodes", "endpoint_hints", "TEXT")?;
    add_column_if_missing(conn, "registered_nodes", "revoked_at", "TEXT")?;
    add_column_if_missing(conn, "registered_nodes", "revocation_reason", "TEXT")?;
    add_column_if_missing(conn, "registered_nodes", "replacement_node_id", "TEXT")?;
    add_column_if_missing(conn, "registered_nodes", "human_visibility_policy", "TEXT")?;
    add_column_if_missing(conn, "registered_nodes", "contact_approval_policy", "TEXT")?;
    add_column_if_missing(
        conn,
        "registered_nodes",
        "agent_reachability_policy",
        "TEXT",
    )?;
    add_column_if_missing(conn, "registered_nodes", "account_id", "TEXT")?;
    add_column_if_missing(conn, "registered_nodes", "device_id", "TEXT")?;

    add_column_if_missing(conn, "cloud_accounts", "password_hash", "TEXT")?;
    add_column_if_missing(conn, "cloud_accounts", "password_algorithm", "TEXT")?;
    add_column_if_missing(conn, "cloud_accounts", "password_updated_at", "TEXT")?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS cloud_contacts (\n             account_id      TEXT NOT NULL,\n             peer_account_id TEXT NOT NULL,\n             created_at      TEXT NOT NULL,\n             PRIMARY KEY (account_id, peer_account_id),\n             FOREIGN KEY(account_id) REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,\n             FOREIGN KEY(peer_account_id) REFERENCES cloud_accounts(account_id) ON DELETE CASCADE\n         );\n         CREATE INDEX IF NOT EXISTS idx_cloud_contacts_account ON cloud_contacts (account_id, created_at);",
    )
    .map_err(ServerInitError::Schema)?;

    migrate_registered_nodes_to_core(conn)?;
    migrate_server_projects_to_core(conn)?;
    remove_legacy_user_state(conn)?;
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_registered_nodes_account_device\n         ON registered_nodes (account_id, device_id);\n         CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_accounts_email_lower\n         ON cloud_accounts(LOWER(primary_email)) WHERE primary_email IS NOT NULL;",
    )
    .map_err(ServerInitError::Schema)?;

    // Schema-version tracked migrations for #332 Phase 1+. Older idempotent
    // schema above is intentionally left alone — these only add NEW changes
    // going forward, recorded in `schema_versions` so each migration runs
    // exactly once per database.
    apply_versioned_migrations(conn)?;
    Ok(())
}

fn apply_versioned_migrations(conn: &Connection) -> Result<(), ServerInitError> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_versions (\n             version    INTEGER PRIMARY KEY,\n             applied_at TEXT NOT NULL\n         );",
    )
    .map_err(ServerInitError::Schema)?;

    apply_migration(
        conn,
        1,
        "server_mailbox covering index for poll/ack",
        |conn| {
            conn.execute_batch(
                "CREATE INDEX IF NOT EXISTS idx_server_mailbox_target_created_message\n                 ON server_mailbox (target_node_id, created_at, message_id);",
            )
        },
    )?;

    apply_migration(
        conn,
        2,
        "registered_nodes api_key_hash partial index for auth middleware",
        |conn| {
            // Partial index on the live (non-revoked) rows only — auth_middleware
            // and the cloud session lookup never care about revoked nodes, so the
            // index only carries the rows the planner actually needs.
            conn.execute_batch(
                "CREATE INDEX IF NOT EXISTS idx_registered_nodes_api_key_hash_live\n                 ON registered_nodes (api_key_hash)\n                 WHERE revoked_at IS NULL;",
            )
        },
    )?;

    apply_migration(
        conn,
        3,
        "registered_nodes (account_id, created_at) for primary_node lookup",
        |conn| {
            // primary_node_for_account orders by created_at DESC after filtering
            // on account_id; the existing (account_id, device_id) composite
            // covers the filter but not the order. Partial again — revoked rows
            // are skipped by every consumer.
            conn.execute_batch(
                "CREATE INDEX IF NOT EXISTS idx_registered_nodes_account_created_live\n                 ON registered_nodes (account_id, created_at)\n                 WHERE revoked_at IS NULL;",
            )
        },
    )?;

    apply_migration(
        conn,
        4,
        "server_mailbox client_message_id idempotency key + partial unique index",
        |conn| {
            // Add the column first; ADD COLUMN has its own implicit IF NOT
            // EXISTS via apply_migration's once-per-version guard. Then the
            // partial unique index — partial because legacy rows that pre-date
            // this column have NULL client_message_id and must stay
            // independent under unique semantics.
            let _ = conn.execute(
                "ALTER TABLE server_mailbox ADD COLUMN client_message_id TEXT",
                [],
            );
            conn.execute_batch(
                "CREATE UNIQUE INDEX IF NOT EXISTS idx_server_mailbox_target_client_msg\n                 ON server_mailbox (target_node_id, client_message_id)\n                 WHERE client_message_id IS NOT NULL;",
            )
        },
    )?;

    Ok(())
}

fn apply_migration<F>(
    conn: &Connection,
    version: i64,
    description: &'static str,
    runner: F,
) -> Result<(), ServerInitError>
where
    F: FnOnce(&Connection) -> Result<(), rusqlite::Error>,
{
    let already: Option<i64> = conn
        .query_row(
            "SELECT version FROM schema_versions WHERE version = ?1",
            rusqlite::params![version],
            |row| row.get(0),
        )
        .ok();
    if already.is_some() {
        return Ok(());
    }
    runner(conn).map_err(|source| ServerInitError::Migration {
        version,
        description,
        source,
    })?;
    conn.execute(
        "INSERT INTO schema_versions (version, applied_at) VALUES (?1, ?2)",
        rusqlite::params![version, chrono::Utc::now().to_rfc3339()],
    )
    .map_err(|source| ServerInitError::Migration {
        version,
        description,
        source,
    })?;
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
            runtime             TEXT,
            human_id            TEXT,
            agent_id            TEXT,
            discovery_mode      TEXT,
            is_default_agent    INTEGER NOT NULL DEFAULT 0,
            api_key_hash        TEXT NOT NULL,
            endpoint_hints      TEXT,
            revoked_at          TEXT,
            revocation_reason   TEXT,
            replacement_node_id TEXT,
            human_visibility_policy TEXT,
            contact_approval_policy TEXT,
            agent_reachability_policy TEXT,
            account_id          TEXT,
            device_id           TEXT,
            created_at          TEXT NOT NULL
        );

        INSERT INTO registered_nodes_new (
            node_id,
            ed25519_pubkey,
            x25519_pubkey,
            display_name,
            owner_name,
            runtime,
            human_id,
            agent_id,
            discovery_mode,
            is_default_agent,
            api_key_hash,
            endpoint_hints,
            revoked_at,
            revocation_reason,
            replacement_node_id,
            human_visibility_policy,
            contact_approval_policy,
            agent_reachability_policy,
            account_id,
            device_id,
            created_at
        )
        SELECT
            node_id,
            ed25519_pubkey,
            x25519_pubkey,
            display_name,
            owner_name,
            NULL,
            NULL,
            NULL,
            'open',
            0,
            api_key_hash,
            endpoint_hints,
            revoked_at,
            revocation_reason,
            replacement_node_id,
            NULL,
            NULL,
            NULL,
            NULL,
            NULL,
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
        .merge(cloud_auth_routes::routes(state.clone()))
        .merge(contacts::routes(state.clone()))
        .merge(discovery::routes(state.clone()))
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
    configure_server_connection(&conn).map_err(|e| format!("configure db: {}", e))?;
    init_server_db(&conn).map_err(|e| e.to_string())?;
    drop(conn);

    let state = Arc::new(ServerState::new(Path::new(db_path).to_path_buf()));
    spawn_mailbox_retention_gc(state.clone());
    let app = router(state);
    let addr = format!("0.0.0.0:{}", port);
    println!("Bridges coordination server on {}", addr);
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .map_err(|e| format!("bind: {}", e))?;
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .await
    .map_err(|e| format!("serve: {}", e))
}

/// Periodic background sweep that prunes mailbox rows older than
/// `relay::MAILBOX_RETENTION_DAYS`. Spawned once when `serve::run` boots so
/// the dead-letter queue can't grow unbounded for offline targets.
fn spawn_mailbox_retention_gc(state: Arc<ServerState>) {
    tokio::spawn(async move {
        // Skip the first tick — give the server a beat to finish booting
        // before we start contending for the write lock.
        let mut ticker = tokio::time::interval(relay::MAILBOX_GC_INTERVAL);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        ticker.tick().await;
        loop {
            ticker.tick().await;
            let runner = match state.db_runner().await {
                Ok(runner) => runner.clone(),
                Err(err) => {
                    eprintln!("[bridges] mailbox GC: db unavailable: {err}");
                    continue;
                }
            };
            let result = runner
                .write::<_, usize, MailboxGcError>(|conn| {
                    Ok(relay::gc_mailbox_retention(conn, relay::MAILBOX_RETENTION_DAYS)?)
                })
                .await;
            match result {
                Ok(count) if count > 0 => {
                    println!("[bridges] mailbox GC: pruned {count} stale row(s)");
                }
                Ok(_) => {}
                Err(err) => eprintln!("[bridges] mailbox GC failed: {err}"),
            }
        }
    });
}

#[derive(Debug)]
enum MailboxGcError {
    Db(db_runner::DbRunnerError),
    Sqlite(rusqlite::Error),
}

impl From<db_runner::DbRunnerError> for MailboxGcError {
    fn from(value: db_runner::DbRunnerError) -> Self {
        Self::Db(value)
    }
}

impl From<rusqlite::Error> for MailboxGcError {
    fn from(value: rusqlite::Error) -> Self {
        Self::Sqlite(value)
    }
}

impl std::fmt::Display for MailboxGcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Db(err) => write!(f, "{err}"),
            Self::Sqlite(err) => write!(f, "sqlite: {err}"),
        }
    }
}

impl std::error::Error for MailboxGcError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DirectAccessKind {
    Person,
    Agent,
    GroupInvite,
    SessionParticipant,
    Any,
}

pub(crate) fn normalize_human_visibility_policy(value: &str) -> Option<String> {
    let normalized = value.trim().to_lowercase();
    match normalized.as_str() {
        "server-open" | "server-approval" | "private" => Some(normalized),
        _ => None,
    }
}

pub(crate) fn normalize_contact_approval_policy(value: &str) -> Option<String> {
    let normalized = value.trim().to_lowercase();
    match normalized.as_str() {
        "auto" | "approval-required" => Some(normalized),
        _ => None,
    }
}

pub(crate) fn normalize_agent_reachability_policy(value: &str) -> Option<String> {
    let normalized = value.trim().to_lowercase();
    match normalized.as_str() {
        "server" | "contacts" | "owner" => Some(normalized),
        _ => None,
    }
}

pub(crate) fn effective_human_visibility_policy(
    discovery_mode: Option<&str>,
    human_visibility_policy: Option<&str>,
) -> String {
    if let Some(policy) = human_visibility_policy.and_then(normalize_human_visibility_policy) {
        return policy;
    }
    match discovery_mode
        .unwrap_or_default()
        .trim()
        .to_lowercase()
        .as_str()
    {
        "contacts" | "off" => "private".to_string(),
        "open" => "server-approval".to_string(),
        _ => "server-approval".to_string(),
    }
}

pub(crate) fn effective_contact_approval_policy(contact_approval_policy: Option<&str>) -> String {
    contact_approval_policy
        .and_then(normalize_contact_approval_policy)
        .unwrap_or_else(|| "approval-required".to_string())
}

pub(crate) fn effective_agent_reachability_policy(
    agent_reachability_policy: Option<&str>,
) -> String {
    agent_reachability_policy
        .and_then(normalize_agent_reachability_policy)
        .unwrap_or_else(|| "contacts".to_string())
}

pub(crate) fn nodes_share_project(
    conn: &Connection,
    left_node_id: &str,
    right_node_id: &str,
) -> Result<bool, rusqlite::Error> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM server_members m1 \
             JOIN server_members m2 ON m1.project_id = m2.project_id \
             WHERE m1.node_id = ?1 AND m2.node_id = ?2 LIMIT 1",
            rusqlite::params![left_node_id, right_node_id],
            |_| Ok(()),
        )
        .is_ok())
}

pub(crate) fn nodes_are_contacts(
    conn: &Connection,
    left_node_id: &str,
    right_node_id: &str,
) -> Result<bool, rusqlite::Error> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM server_contacts WHERE node_id = ?1 AND contact_node_id = ?2 LIMIT 1",
            rusqlite::params![left_node_id, right_node_id],
            |_| Ok(()),
        )
        .is_ok())
}

pub(crate) fn nodes_share_project_or_contact(
    conn: &Connection,
    left_node_id: &str,
    right_node_id: &str,
) -> Result<bool, rusqlite::Error> {
    if left_node_id == right_node_id {
        return Ok(true);
    }
    if nodes_share_project(conn, left_node_id, right_node_id)? {
        return Ok(true);
    }
    nodes_are_contacts(conn, left_node_id, right_node_id)
}

fn node_human_id(conn: &Connection, node_id: &str) -> Result<Option<String>, rusqlite::Error> {
    use rusqlite::OptionalExtension;
    conn.query_row(
        "SELECT human_id FROM registered_nodes WHERE node_id = ?1 AND revoked_at IS NULL",
        rusqlite::params![node_id],
        |row| row.get(0),
    )
    .optional()
    .map(|value| value.flatten())
}

pub(crate) fn nodes_share_human_owner(
    conn: &Connection,
    left_node_id: &str,
    right_node_id: &str,
) -> Result<bool, rusqlite::Error> {
    let left = node_human_id(conn, left_node_id)?;
    let right = node_human_id(conn, right_node_id)?;
    Ok(
        matches!((left, right), (Some(left), Some(right)) if !left.trim().is_empty() && left == right),
    )
}

pub(crate) fn nodes_have_rejected_contact_request(
    conn: &Connection,
    left_node_id: &str,
    right_node_id: &str,
) -> Result<bool, rusqlite::Error> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM server_contact_requests
             WHERE status = 'rejected'
               AND ((requester_node_id = ?1 AND target_node_id = ?2) OR (requester_node_id = ?2 AND target_node_id = ?1))
             LIMIT 1",
            rusqlite::params![left_node_id, right_node_id],
            |_| Ok(()),
        )
        .is_ok())
}

pub(crate) fn nodes_can_directly_reach(
    conn: &Connection,
    sender_node_id: &str,
    target_node_id: &str,
    access_kind: DirectAccessKind,
) -> Result<bool, rusqlite::Error> {
    use rusqlite::OptionalExtension;

    if sender_node_id == target_node_id {
        return Ok(true);
    }

    let target = conn
        .query_row(
            "SELECT discovery_mode, human_visibility_policy, agent_reachability_policy, agent_id \
             FROM registered_nodes WHERE node_id = ?1 AND revoked_at IS NULL",
            rusqlite::params![target_node_id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            },
        )
        .optional()?;
    let Some((discovery_mode, human_policy, agent_policy, agent_id)) = target else {
        return Ok(false);
    };

    let human_policy =
        effective_human_visibility_policy(discovery_mode.as_deref(), human_policy.as_deref());
    let agent_policy = effective_agent_reachability_policy(agent_policy.as_deref());
    let target_is_agent = agent_id
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty());
    let linked_by_contact = nodes_are_contacts(conn, sender_node_id, target_node_id)?;
    if !linked_by_contact
        && nodes_have_rejected_contact_request(conn, sender_node_id, target_node_id)?
    {
        return Ok(false);
    }
    let linked_by_project_or_contact =
        nodes_share_project(conn, sender_node_id, target_node_id)? || linked_by_contact;

    let person_access = || human_policy == "server-open" || linked_by_contact;
    let agent_access = || -> Result<bool, rusqlite::Error> {
        if !target_is_agent {
            return Ok(false);
        }
        match agent_policy.as_str() {
            "server" => Ok(true),
            "contacts" => Ok(linked_by_project_or_contact),
            "owner" => nodes_share_human_owner(conn, sender_node_id, target_node_id),
            _ => Ok(false),
        }
    };

    match access_kind {
        DirectAccessKind::Person => Ok(person_access()),
        DirectAccessKind::Agent => agent_access(),
        DirectAccessKind::GroupInvite => Ok(linked_by_contact),
        DirectAccessKind::SessionParticipant => Ok(true),
        DirectAccessKind::Any if target_is_agent => agent_access(),
        DirectAccessKind::Any => Ok(person_access()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn table_exists(conn: &Connection, table: &str) -> bool {
        conn.query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
            rusqlite::params![table],
            |_| Ok(()),
        )
        .is_ok()
    }

    fn column_exists(conn: &Connection, table: &str, column: &str) -> bool {
        let sql = format!("PRAGMA table_info({table})");
        let mut stmt = conn.prepare(&sql).expect("prepare table info");
        let exists = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .expect("query table info")
            .filter_map(Result::ok)
            .any(|name| name == column);
        exists
    }

    #[test]
    fn server_schema_creates_cloud_account_foundation() {
        let db_path = std::env::temp_dir().join(format!(
            "bridges-server-cloud-auth-schema-{}.db",
            uuid::Uuid::new_v4()
        ));
        let conn = Connection::open(&db_path).expect("open db");
        init_server_db(&conn).expect("init db");

        for table in [
            "cloud_accounts",
            "cloud_account_identities",
            "cloud_devices",
            "cloud_refresh_tokens",
            "cloud_audit_events",
        ] {
            assert!(table_exists(&conn, table), "expected {table} table");
        }

        for column in ["account_id", "device_id"] {
            assert!(
                column_exists(&conn, "registered_nodes", column),
                "expected registered_nodes.{column} column"
            );
        }

        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn server_schema_adds_cloud_columns_to_existing_registered_nodes() {
        let db_path = std::env::temp_dir().join(format!(
            "bridges-server-cloud-auth-legacy-{}.db",
            uuid::Uuid::new_v4()
        ));
        let conn = Connection::open(&db_path).expect("open db");
        conn.execute_batch(
            r#"
            CREATE TABLE registered_nodes (
                node_id TEXT PRIMARY KEY,
                ed25519_pubkey TEXT NOT NULL,
                x25519_pubkey TEXT NOT NULL,
                api_key_hash TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            "#,
        )
        .expect("seed legacy schema");

        init_server_db(&conn).expect("init db should migrate old registered_nodes table");

        assert!(column_exists(&conn, "registered_nodes", "account_id"));
        assert!(column_exists(&conn, "registered_nodes", "device_id"));
        assert!(
            conn.query_row(
                "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_registered_nodes_account_device'",
                [],
                |_| Ok(()),
            )
            .is_ok(),
            "expected account/device lookup index"
        );

        let _ = std::fs::remove_file(db_path);
    }

    fn index_exists(conn: &Connection, name: &str) -> bool {
        conn.query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?1",
            rusqlite::params![name],
            |_| Ok(()),
        )
        .is_ok()
    }

    /// Run EXPLAIN QUERY PLAN against `sql` and return one joined string of
    /// every plan-step detail. Tests assert the expected index name appears
    /// in that joined text — the planner picks it for the query.
    fn explain_plan(conn: &Connection, sql: &str) -> String {
        let prepared_sql = format!("EXPLAIN QUERY PLAN {sql}");
        let mut stmt = conn.prepare(&prepared_sql).expect("prepare explain");
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(3))
            .expect("query explain rows");
        let mut details = Vec::new();
        for row in rows {
            details.push(row.expect("explain row"));
        }
        details.join(" | ")
    }

    #[test]
    fn auth_middleware_lookup_uses_api_key_hash_index() {
        let db_path = std::env::temp_dir().join(format!(
            "bridges-server-explain-auth-{}.db",
            uuid::Uuid::new_v4()
        ));
        let conn = Connection::open(&db_path).expect("open db");
        init_server_db(&conn).expect("init db");

        let plan = explain_plan(
            &conn,
            "SELECT node_id FROM registered_nodes WHERE api_key_hash = 'x' AND revoked_at IS NULL",
        );
        assert!(
            plan.contains("idx_registered_nodes_api_key_hash_live"),
            "expected auth lookup to use partial api_key_hash index, got plan: {plan}"
        );

        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn primary_node_lookup_uses_account_created_index() {
        let db_path = std::env::temp_dir().join(format!(
            "bridges-server-explain-account-{}.db",
            uuid::Uuid::new_v4()
        ));
        let conn = Connection::open(&db_path).expect("open db");
        init_server_db(&conn).expect("init db");

        let plan = explain_plan(
            &conn,
            "SELECT node_id FROM registered_nodes WHERE account_id = 'a' AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1",
        );
        assert!(
            plan.contains("idx_registered_nodes_account_created_live"),
            "expected primary_node lookup to use account_created partial index, got plan: {plan}"
        );

        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn mailbox_poll_uses_covering_index() {
        let db_path = std::env::temp_dir().join(format!(
            "bridges-server-explain-mailbox-{}.db",
            uuid::Uuid::new_v4()
        ));
        let conn = Connection::open(&db_path).expect("open db");
        init_server_db(&conn).expect("init db");

        let plan = explain_plan(
            &conn,
            "SELECT message_id, from_node_id, blob, project_id, created_at \
             FROM server_mailbox WHERE target_node_id = 't' \
             ORDER BY created_at ASC, message_id ASC LIMIT 100",
        );
        assert!(
            plan.contains("idx_server_mailbox_target_created"),
            "expected mailbox poll to use a target_created index, got plan: {plan}"
        );

        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn schema_versions_records_applied_migrations_and_is_idempotent() {
        let db_path = std::env::temp_dir().join(format!(
            "bridges-server-schema-versions-{}.db",
            uuid::Uuid::new_v4()
        ));
        let conn = Connection::open(&db_path).expect("open db");
        init_server_db(&conn).expect("init db");

        // Migration 1 lands the covering mailbox index.
        assert!(index_exists(&conn, "idx_server_mailbox_target_created_message"));

        // schema_versions has migration 1 recorded exactly once.
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM schema_versions WHERE version = 1",
                [],
                |row| row.get(0),
            )
            .expect("count migrations");
        assert_eq!(count, 1);

        // Re-running init_server_db is a no-op for already-applied versions.
        init_server_db(&conn).expect("re-init db");
        let count_after: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM schema_versions WHERE version = 1",
                [],
                |row| row.get(0),
            )
            .expect("count migrations after re-init");
        assert_eq!(count_after, 1);

        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn server_connections_apply_busy_timeout_for_concurrent_mailbox_writes() {
        let db_path = std::env::temp_dir().join(format!(
            "bridges-server-busy-timeout-{}.db",
            uuid::Uuid::new_v4()
        ));
        let conn = Connection::open(&db_path).expect("open db");
        init_server_db(&conn).expect("init db");
        drop(conn);

        let state = ServerState::new(db_path.clone());
        let conn = state.open_connection().expect("open server connection");
        let busy_timeout_ms: i64 = conn
            .query_row("PRAGMA busy_timeout", [], |row| row.get(0))
            .expect("read busy timeout");

        assert!(
            busy_timeout_ms >= 5_000,
            "server writes should wait for transient SQLite locks instead of failing immediately"
        );
        let journal_mode: String = conn
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .expect("read journal mode");
        assert_eq!(journal_mode.to_ascii_lowercase(), "wal");

        let _ = std::fs::remove_file(db_path);
    }
}

const SERVER_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS registered_nodes (
    node_id             TEXT PRIMARY KEY,
    ed25519_pubkey      TEXT NOT NULL,
    x25519_pubkey       TEXT NOT NULL,
    display_name        TEXT,
    owner_name          TEXT,
    runtime             TEXT,
    human_id            TEXT,
    agent_id            TEXT,
    discovery_mode      TEXT,
    is_default_agent    INTEGER NOT NULL DEFAULT 0,
    api_key_hash        TEXT NOT NULL,
    endpoint_hints      TEXT,
    revoked_at          TEXT,
    revocation_reason   TEXT,
    replacement_node_id TEXT,
    human_visibility_policy TEXT,
    contact_approval_policy TEXT,
    agent_reachability_policy TEXT,
    account_id          TEXT,
    device_id           TEXT,
    created_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS server_contacts (
    node_id             TEXT NOT NULL,
    contact_node_id     TEXT NOT NULL,
    created_at          TEXT NOT NULL,
    PRIMARY KEY (node_id, contact_node_id)
);

CREATE TABLE IF NOT EXISTS server_contact_requests (
    request_id          TEXT PRIMARY KEY,
    requester_node_id   TEXT NOT NULL,
    target_node_id      TEXT NOT NULL,
    status              TEXT NOT NULL,
    message             TEXT,
    created_at          TEXT NOT NULL,
    decided_at          TEXT
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

CREATE TABLE IF NOT EXISTS cloud_accounts (
    account_id      TEXT PRIMARY KEY,
    display_name    TEXT,
    primary_email   TEXT,
    avatar_url      TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cloud_account_identities (
    identity_id      TEXT PRIMARY KEY,
    account_id       TEXT NOT NULL,
    provider         TEXT NOT NULL,
    provider_subject TEXT NOT NULL,
    provider_username TEXT,
    email            TEXT,
    email_verified   INTEGER NOT NULL DEFAULT 0,
    avatar_url       TEXT,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL,
    UNIQUE(provider, provider_subject),
    FOREIGN KEY(account_id) REFERENCES cloud_accounts(account_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS cloud_devices (
    device_id        TEXT PRIMARY KEY,
    account_id       TEXT NOT NULL,
    device_name      TEXT,
    device_public_key TEXT NOT NULL,
    created_at       TEXT NOT NULL,
    last_seen_at     TEXT NOT NULL,
    revoked_at       TEXT,
    FOREIGN KEY(account_id) REFERENCES cloud_accounts(account_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS cloud_refresh_tokens (
    token_id         TEXT PRIMARY KEY,
    account_id       TEXT NOT NULL,
    device_id        TEXT NOT NULL,
    token_hash       TEXT NOT NULL UNIQUE,
    created_at       TEXT NOT NULL,
    expires_at       TEXT NOT NULL,
    revoked_at       TEXT,
    FOREIGN KEY(account_id) REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    FOREIGN KEY(device_id) REFERENCES cloud_devices(device_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS cloud_audit_events (
    event_id         TEXT PRIMARY KEY,
    account_id       TEXT,
    device_id        TEXT,
    event_type       TEXT NOT NULL,
    metadata_json    TEXT,
    created_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_server_contacts_node_created
    ON server_contacts (node_id, created_at);

CREATE INDEX IF NOT EXISTS idx_server_contact_requests_target_status
    ON server_contact_requests (target_node_id, status, created_at);

CREATE INDEX IF NOT EXISTS idx_server_contact_requests_requester_status
    ON server_contact_requests (requester_node_id, status, created_at);

CREATE INDEX IF NOT EXISTS idx_server_mailbox_target_created
    ON server_mailbox (target_node_id, created_at);

CREATE INDEX IF NOT EXISTS idx_cloud_account_identities_account
    ON cloud_account_identities (account_id, provider);

CREATE INDEX IF NOT EXISTS idx_cloud_devices_account
    ON cloud_devices (account_id, revoked_at, last_seen_at);
"#;
