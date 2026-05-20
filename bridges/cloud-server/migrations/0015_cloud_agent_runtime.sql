-- Server-side reachability/capability state for each account's Cloud agent.
-- Reachability is separated from local-device execution so an agent can stay
-- addressable through the server while owner-device tools are unavailable.
CREATE TABLE IF NOT EXISTS cloud_agent_runtime_status (
    account_id TEXT PRIMARY KEY
        REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    reachability_state TEXT NOT NULL,
    local_execution_state TEXT NOT NULL,
    readonly_fallback_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TEXT NOT NULL,
    CHECK (reachability_state IN ('online', 'offline')),
    CHECK (local_execution_state IN ('available', 'paused')),
    CHECK (reachability_state != 'offline' OR local_execution_state = 'paused')
);

CREATE INDEX IF NOT EXISTS idx_cloud_agent_runtime_status_updated
    ON cloud_agent_runtime_status (updated_at);
