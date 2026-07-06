CREATE TABLE IF NOT EXISTS cloud_read_cursors (
    account_id      TEXT NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    scope_kind      TEXT NOT NULL CHECK (scope_kind IN ('peer', 'session')),
    scope_id        TEXT NOT NULL,
    read_at         TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    PRIMARY KEY (account_id, scope_kind, scope_id)
);

CREATE INDEX IF NOT EXISTS idx_cloud_read_cursors_account_scope
    ON cloud_read_cursors (account_id, scope_kind, scope_id);
