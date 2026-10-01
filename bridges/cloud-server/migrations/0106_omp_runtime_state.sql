-- Runtime replay data is private to the leased runner, never part of chat sync.
ALTER TABLE cloud_agent_fallback_runs ADD COLUMN IF NOT EXISTS omp_input_json JSONB;
CREATE TABLE IF NOT EXISTS cloud_agent_omp_state (
    run_id TEXT PRIMARY KEY REFERENCES cloud_agent_fallback_runs(run_id) ON DELETE CASCADE,
    owner_account_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    execution_agent_id TEXT NOT NULL,
    route_json JSONB NOT NULL,
    auth_snapshot_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    response_message_id TEXT NOT NULL,
    state_json JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cloud_agent_omp_state_session_idx
    ON cloud_agent_omp_state(owner_account_id, session_id, execution_agent_id, created_at DESC);
