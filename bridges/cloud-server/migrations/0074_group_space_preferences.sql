CREATE TABLE IF NOT EXISTS cloud_account_group_space_preferences (
    account_id     TEXT NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    group_space_id TEXT NOT NULL,
    pinned_at      TIMESTAMPTZ,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (account_id, group_space_id)
);
