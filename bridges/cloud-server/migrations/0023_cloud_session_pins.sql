-- Durable pinned-message state for Cloud sessions.
--
-- Shared pins are visible to every participant of a contact/group session.
-- Private pins are per account and override the shared pin only for that account.
-- message_id stores the UI-visible/canonical message id because group messages
-- use envelope ids that do not always match the outer cloud_messages row id.

CREATE TABLE IF NOT EXISTS cloud_session_shared_pins (
    session_id            TEXT PRIMARY KEY,
    message_id            TEXT NOT NULL,
    updated_by_account_id TEXT NOT NULL
        REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    updated_at            TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cloud_account_session_pins (
    account_id TEXT NOT NULL
        REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    session_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (account_id, session_id)
);

CREATE INDEX IF NOT EXISTS idx_cloud_account_session_pins_session
    ON cloud_account_session_pins (session_id);
