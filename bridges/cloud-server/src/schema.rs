//! Cloud-native server SQLite schema and migrations.
//!
//! Uses the same versioned migration framework as `bridges/cli`, but the
//! migration history is independent: this server starts at version 1, and
//! every change ships as a numbered, idempotent migration.

use std::time::Duration;

use rusqlite::Connection;

use crate::error::ServerInitError;

/// Configure a fresh connection: WAL, NORMAL sync, FK enforcement, busy
/// timeout matching the bridges/cli pattern.
pub(crate) fn configure_server_connection(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.busy_timeout(Duration::from_secs(5))?;
    conn.execute_batch(
        "PRAGMA foreign_keys = ON;\n         PRAGMA journal_mode = WAL;\n         PRAGMA synchronous = NORMAL;",
    )?;
    Ok(())
}

/// Initialise the cloud-server schema. Idempotent.
pub fn init_server_db(conn: &Connection) -> Result<(), ServerInitError> {
    conn.execute_batch(BASE_SCHEMA).map_err(ServerInitError::Schema)?;
    apply_versioned_migrations(conn)?;
    Ok(())
}

const BASE_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS cloud_accounts (
    account_id          TEXT PRIMARY KEY,
    display_name        TEXT,
    primary_email       TEXT,
    avatar_url          TEXT,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,
    password_hash       TEXT,
    password_algorithm  TEXT,
    password_updated_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_accounts_email_lower
    ON cloud_accounts(LOWER(primary_email))
    WHERE primary_email IS NOT NULL;

CREATE TABLE IF NOT EXISTS cloud_account_identities (
    identity_id       TEXT PRIMARY KEY,
    account_id        TEXT NOT NULL,
    provider          TEXT NOT NULL,
    provider_subject  TEXT NOT NULL,
    provider_username TEXT,
    email             TEXT,
    email_verified    INTEGER NOT NULL DEFAULT 0,
    avatar_url        TEXT,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL,
    UNIQUE(provider, provider_subject),
    FOREIGN KEY(account_id) REFERENCES cloud_accounts(account_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_cloud_account_identities_account
    ON cloud_account_identities (account_id, provider);

CREATE TABLE IF NOT EXISTS cloud_devices (
    device_id         TEXT PRIMARY KEY,
    account_id        TEXT NOT NULL,
    device_name       TEXT,
    device_public_key TEXT NOT NULL,
    created_at        TEXT NOT NULL,
    last_seen_at      TEXT NOT NULL,
    revoked_at        TEXT,
    FOREIGN KEY(account_id) REFERENCES cloud_accounts(account_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_cloud_devices_account
    ON cloud_devices (account_id, revoked_at, last_seen_at);

CREATE TABLE IF NOT EXISTS cloud_refresh_tokens (
    token_id    TEXT PRIMARY KEY,
    account_id  TEXT NOT NULL,
    device_id   TEXT NOT NULL,
    token_hash  TEXT NOT NULL UNIQUE,
    created_at  TEXT NOT NULL,
    expires_at  TEXT NOT NULL,
    revoked_at  TEXT,
    FOREIGN KEY(account_id) REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    FOREIGN KEY(device_id) REFERENCES cloud_devices(device_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS cloud_audit_events (
    event_id      TEXT PRIMARY KEY,
    account_id    TEXT,
    device_id     TEXT,
    event_type    TEXT NOT NULL,
    metadata_json TEXT,
    created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cloud_contacts (
    account_id      TEXT NOT NULL,
    peer_account_id TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    PRIMARY KEY (account_id, peer_account_id),
    FOREIGN KEY(account_id) REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    FOREIGN KEY(peer_account_id) REFERENCES cloud_accounts(account_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_cloud_contacts_account ON cloud_contacts (account_id, created_at);
"#;

fn apply_versioned_migrations(conn: &Connection) -> Result<(), ServerInitError> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_versions (\n             version    INTEGER PRIMARY KEY,\n             applied_at TEXT NOT NULL\n         );",
    )
    .map_err(ServerInitError::Schema)?;

    apply_migration(
        conn,
        1,
        "server_messages + server_message_recipients tables",
        |conn| {
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS server_messages (\n                     message_id        TEXT PRIMARY KEY,\n                     sender_node_id    TEXT NOT NULL,\n                     project_id        TEXT,\n                     payload_blob      TEXT,\n                     client_message_id TEXT,\n                     created_at        TEXT NOT NULL\n                 );\n                 CREATE INDEX IF NOT EXISTS idx_server_messages_sender_created\n                     ON server_messages(sender_node_id, created_at);\n                 CREATE UNIQUE INDEX IF NOT EXISTS idx_server_messages_client_msg\n                     ON server_messages(sender_node_id, client_message_id)\n                     WHERE client_message_id IS NOT NULL;\n                 CREATE TABLE IF NOT EXISTS server_message_recipients (\n                     message_id        TEXT NOT NULL,\n                     recipient_node_id TEXT NOT NULL,\n                     ciphertext_blob   TEXT,\n                     delivered_at      TEXT,\n                     read_at           TEXT,\n                     PRIMARY KEY (message_id, recipient_node_id),\n                     FOREIGN KEY (message_id) REFERENCES server_messages(message_id) ON DELETE CASCADE\n                 );\n                 CREATE INDEX IF NOT EXISTS idx_server_message_recipients_recipient\n                     ON server_message_recipients(recipient_node_id, delivered_at);",
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
