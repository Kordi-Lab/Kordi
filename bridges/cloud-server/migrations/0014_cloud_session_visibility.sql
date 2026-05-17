-- Account-scoped cloud chat visibility. Hidden chats are excluded from the
-- sidebar but can be restored. Deleted chats are removed from this account's
-- view and must not reappear on fresh device sync.
CREATE TABLE IF NOT EXISTS cloud_account_session_visibility (
    account_id TEXT NOT NULL
        REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    session_id TEXT NOT NULL,
    hidden_at TEXT,
    deleted_at TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (account_id, session_id),
    CHECK (hidden_at IS NOT NULL OR deleted_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_cloud_account_session_visibility_account_updated
    ON cloud_account_session_visibility (account_id, updated_at);

CREATE INDEX IF NOT EXISTS idx_cloud_account_session_visibility_session
    ON cloud_account_session_visibility (session_id);
