CREATE TABLE IF NOT EXISTS cloud_agent_fallback_runs (
    run_id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    request_message_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    owner_account_id TEXT NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    requester_account_id TEXT NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('queued', 'leased', 'running', 'completed', 'failed', 'cancelled')),
    prompt TEXT NOT NULL,
    claimed_by TEXT,
    lease_expires_at TEXT,
    response_message_id TEXT,
    error_code TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_cloud_agent_fallback_runs_owner_status
    ON cloud_agent_fallback_runs(owner_account_id, status, updated_at);

CREATE INDEX IF NOT EXISTS idx_cloud_agent_fallback_runs_requester_session
    ON cloud_agent_fallback_runs(requester_account_id, session_id, updated_at);

CREATE TABLE IF NOT EXISTS cloud_agent_fallback_run_events (
    event_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES cloud_agent_fallback_runs(run_id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cloud_agent_fallback_run_events_run_created
    ON cloud_agent_fallback_run_events(run_id, created_at);
