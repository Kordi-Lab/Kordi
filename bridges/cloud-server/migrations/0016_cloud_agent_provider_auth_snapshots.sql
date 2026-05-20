-- Account-scoped provider auth snapshots for server-side read-only fallback.
-- auth_json intentionally preserves the same JSON shape as local auth.json so
-- the fallback runtime can reuse the same agent/provider auth path.
CREATE TABLE IF NOT EXISTS cloud_agent_provider_auth_snapshots (
    account_id TEXT PRIMARY KEY
        REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    format_version INTEGER NOT NULL,
    auth_json JSONB NOT NULL,
    active_provider TEXT,
    active_profile_id TEXT,
    updated_at TEXT NOT NULL,
    CHECK (format_version > 0)
);

CREATE INDEX IF NOT EXISTS idx_cloud_agent_provider_auth_snapshots_updated
    ON cloud_agent_provider_auth_snapshots (updated_at);
