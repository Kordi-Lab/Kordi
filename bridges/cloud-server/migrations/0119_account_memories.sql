-- Account memories saved by agents or people, owned by the account rather
-- than a device, plus the per-account memory switches. Rows are removed with
-- the account. Archived rows are hidden and never read by agents.
CREATE TABLE cloud_account_memories (
    memory_id TEXT PRIMARY KEY,
    owner_account_id TEXT NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    scope TEXT NOT NULL CHECK (scope IN ('conversation', 'group', 'project')),
    scope_id TEXT NOT NULL,
    scope_label TEXT,
    source TEXT NOT NULL CHECK (source IN ('user_correction', 'repeated_failure', 'outcome', 'manual')),
    text TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    archived_at TIMESTAMPTZ
);
CREATE INDEX cloud_account_memories_owner_scope_idx ON cloud_account_memories (owner_account_id, scope, scope_id) WHERE archived_at IS NULL;
CREATE TABLE cloud_account_memory_settings (
    account_id TEXT PRIMARY KEY REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    memory_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    exclude_sensitive BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
