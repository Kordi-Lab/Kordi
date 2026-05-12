-- OAuth login state for Cloud Edition social providers.

CREATE TABLE IF NOT EXISTS cloud_oauth_states (
    state_id      TEXT PRIMARY KEY,
    provider      TEXT NOT NULL,
    redirect_after TEXT NOT NULL,
    code_verifier TEXT,
    created_at    TEXT NOT NULL,
    expires_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cloud_oauth_states_expires
    ON cloud_oauth_states (expires_at);
