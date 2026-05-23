CREATE TABLE IF NOT EXISTS cloud_agent_sandboxes (
    sandbox_id TEXT PRIMARY KEY,
    owner_account_id TEXT NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    requester_account_id TEXT REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    session_id TEXT NOT NULL,
    scope TEXT NOT NULL CHECK (scope IN ('shared_session', 'requester_isolated')),
    status TEXT NOT NULL CHECK (status IN ('active', 'expired', 'deleted')),
    workspace_key TEXT NOT NULL,
    storage_bytes_used BIGINT NOT NULL DEFAULT 0 CHECK (storage_bytes_used >= 0),
    storage_bytes_quota BIGINT NOT NULL CHECK (storage_bytes_quota >= 0),
    created_at TEXT NOT NULL,
    last_active_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_agent_sandboxes_workspace_active
    ON cloud_agent_sandboxes(workspace_key)
    WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_cloud_agent_sandboxes_session_status
    ON cloud_agent_sandboxes(session_id, status, last_active_at);

CREATE INDEX IF NOT EXISTS idx_cloud_agent_sandboxes_expiry
    ON cloud_agent_sandboxes(expires_at)
    WHERE status = 'active';

ALTER TABLE cloud_agent_fallback_runs
    ADD COLUMN IF NOT EXISTS sandbox_id TEXT REFERENCES cloud_agent_sandboxes(sandbox_id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_cloud_agent_fallback_runs_sandbox
    ON cloud_agent_fallback_runs(sandbox_id)
    WHERE sandbox_id IS NOT NULL;
