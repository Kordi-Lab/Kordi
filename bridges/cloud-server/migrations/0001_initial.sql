-- Kordi cloud-server initial Postgres schema (sqlx::migrate convention).
--
-- Mirrors the existing SQLite schema in bridges/cloud-server/src/schema.rs as
-- closely as possible so the rusqlite → sqlx port (session 4 of the k3s
-- rollout) is a driver swap, not a data-model rewrite. ID columns stay TEXT
-- and timestamp columns stay TEXT (RFC3339); promoting them to UUID and
-- TIMESTAMPTZ is a future cleanup.

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
    account_id        TEXT NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    provider          TEXT NOT NULL,
    provider_subject  TEXT NOT NULL,
    provider_username TEXT,
    email             TEXT,
    -- BOOLEAN replaces the SQLite INTEGER 0/1 we used; the Rust side already
    -- treats this as a bool through serde so the wire shape doesn't move.
    email_verified    BOOLEAN NOT NULL DEFAULT FALSE,
    avatar_url        TEXT,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL,
    UNIQUE (provider, provider_subject)
);

CREATE INDEX IF NOT EXISTS idx_cloud_account_identities_account
    ON cloud_account_identities (account_id, provider);

CREATE TABLE IF NOT EXISTS cloud_devices (
    device_id         TEXT PRIMARY KEY,
    account_id        TEXT NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    device_name       TEXT,
    device_public_key TEXT NOT NULL,
    created_at        TEXT NOT NULL,
    last_seen_at      TEXT NOT NULL,
    revoked_at        TEXT
);

CREATE INDEX IF NOT EXISTS idx_cloud_devices_account
    ON cloud_devices (account_id, revoked_at, last_seen_at);

CREATE TABLE IF NOT EXISTS cloud_refresh_tokens (
    token_id    TEXT PRIMARY KEY,
    account_id  TEXT NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    device_id   TEXT NOT NULL REFERENCES cloud_devices(device_id) ON DELETE CASCADE,
    token_hash  TEXT NOT NULL UNIQUE,
    created_at  TEXT NOT NULL,
    expires_at  TEXT NOT NULL,
    revoked_at  TEXT
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
    account_id      TEXT NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    peer_account_id TEXT NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    created_at      TEXT NOT NULL,
    PRIMARY KEY (account_id, peer_account_id)
);

CREATE INDEX IF NOT EXISTS idx_cloud_contacts_account
    ON cloud_contacts (account_id, created_at);

-- Telegram-style message log: one server_messages row per send, plus one
-- server_message_recipients row per recipient. Broadcast fanout writes
-- 1 + N rows instead of N full-copy mailbox rows.
CREATE TABLE IF NOT EXISTS server_messages (
    message_id        TEXT PRIMARY KEY,
    sender_node_id    TEXT NOT NULL,
    project_id        TEXT,
    payload_blob      TEXT,
    client_message_id TEXT,
    created_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_server_messages_sender_created
    ON server_messages (sender_node_id, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_server_messages_client_msg
    ON server_messages (sender_node_id, client_message_id)
    WHERE client_message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS server_message_recipients (
    message_id        TEXT NOT NULL REFERENCES server_messages(message_id) ON DELETE CASCADE,
    recipient_node_id TEXT NOT NULL,
    ciphertext_blob   TEXT,
    delivered_at      TEXT,
    read_at           TEXT,
    PRIMARY KEY (message_id, recipient_node_id)
);

CREATE INDEX IF NOT EXISTS idx_server_message_recipients_recipient
    ON server_message_recipients (recipient_node_id, delivered_at);
