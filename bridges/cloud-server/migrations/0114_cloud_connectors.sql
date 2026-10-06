-- Connectors: per-account links to third-party services (issue 1712).
-- Credentials live only in cloud_connector_secrets, encrypted with the
-- provider-auth cipher. Every other table here is safe to serialize.

CREATE TABLE cloud_connectors (
    connector_id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('connected', 'needs_reauth', 'revoked')),
    read_scopes TEXT[] NOT NULL DEFAULT '{}',
    act_scopes TEXT[] NOT NULL DEFAULT '{}',
    act_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at TIMESTAMPTZ,
    CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);

-- One live connector per account and provider; revoked rows stay for audit.
CREATE UNIQUE INDEX idx_cloud_connectors_account_provider_live
    ON cloud_connectors (account_id, provider)
    WHERE status <> 'revoked';

-- Read only by the connector broker and the connector OAuth module.
CREATE TABLE cloud_connector_secrets (
    connector_id TEXT PRIMARY KEY REFERENCES cloud_connectors(connector_id) ON DELETE CASCADE,
    ciphertext BYTEA NOT NULL,
    nonce BYTEA NOT NULL,
    key_version INTEGER NOT NULL,
    refresh_ciphertext BYTEA,
    expires_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE cloud_connector_agent_grants (
    connector_id TEXT NOT NULL REFERENCES cloud_connectors(connector_id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL,
    PRIMARY KEY (connector_id, agent_id)
);

CREATE TABLE cloud_connector_events (
    event_id TEXT PRIMARY KEY,
    connector_id TEXT NOT NULL REFERENCES cloud_connectors(connector_id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    kind TEXT NOT NULL,
    external_id TEXT,
    occurred_at TIMESTAMPTZ NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}',
    received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_cloud_connector_events_connector_occurred
    ON cloud_connector_events (connector_id, occurred_at DESC);
CREATE INDEX idx_cloud_connector_events_expires
    ON cloud_connector_events (expires_at);

CREATE TABLE cloud_connector_audit (
    audit_id TEXT PRIMARY KEY,
    connector_id TEXT NOT NULL REFERENCES cloud_connectors(connector_id) ON DELETE CASCADE,
    account_id TEXT NOT NULL,
    run_id TEXT,
    agent_id TEXT,
    tool TEXT NOT NULL,
    tool_group TEXT NOT NULL CHECK (tool_group IN ('read', 'act')),
    outcome TEXT NOT NULL
        CHECK (outcome IN ('completed', 'approved', 'denied', 'blocked_background', 'failed')),
    summary TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_cloud_connector_audit_connector_created
    ON cloud_connector_audit (connector_id, created_at DESC);

-- Queue drained by the content-removal worker (issue 1685) once it lands.
-- No foreign keys: a request must outlive the connector it names.
CREATE TABLE cloud_connector_removal_requests (
    request_id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    connector_id TEXT NOT NULL,
    requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at TIMESTAMPTZ
);

CREATE INDEX idx_cloud_connector_removal_requests_pending
    ON cloud_connector_removal_requests (requested_at)
    WHERE processed_at IS NULL;

-- One-use OAuth state for connector grants, bound to the signed-in account,
-- the provider, and the requested grant. Separate from cloud_oauth_states,
-- which serves sign-in and carries no account.
CREATE TABLE cloud_connector_oauth_states (
    state_id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    grant_kind TEXT NOT NULL CHECK (grant_kind IN ('read', 'act')),
    redirect_after TEXT,
    code_verifier TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_cloud_connector_oauth_states_expires
    ON cloud_connector_oauth_states (expires_at);
