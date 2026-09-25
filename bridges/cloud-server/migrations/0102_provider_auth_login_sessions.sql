-- Server-owned provider login sessions. Credentials never enter this table:
-- a completed session only references the encrypted snapshot it produced.
CREATE TABLE IF NOT EXISTS cloud_agent_provider_login_sessions (
    session_id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    device_id TEXT NOT NULL REFERENCES cloud_devices(device_id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    worker_provider TEXT NOT NULL,
    label TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running'
        CHECK (status IN ('running', 'claiming', 'completed', 'failed', 'cancelled', 'expired')),
    failure_reason TEXT,
    snapshot_id TEXT REFERENCES cloud_agent_provider_auth_snapshots(snapshot_id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cloud_agent_provider_login_sessions_account_created
    ON cloud_agent_provider_login_sessions(account_id, created_at);
