CREATE TABLE IF NOT EXISTS cloud_agent_definitions (
    agent_id            TEXT PRIMARY KEY,
    owner_account_id    TEXT NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    access_scope        TEXT NOT NULL DEFAULT 'private',
    status              TEXT NOT NULL DEFAULT 'active',
    name                TEXT NOT NULL,
    role                TEXT NOT NULL,
    description         TEXT,
    system_prompt       TEXT NOT NULL,
    source_summary      TEXT,
    boundaries_json     JSONB NOT NULL DEFAULT '[]',
    resources_json      JSONB NOT NULL DEFAULT '[]',
    skills_json         JSONB NOT NULL DEFAULT '[]',
    model_routing_json  JSONB NOT NULL DEFAULT '{}',
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,
    archived_at         TEXT,
    CONSTRAINT cloud_agent_definitions_access_scope_check
        CHECK (access_scope IN ('private')),
    CONSTRAINT cloud_agent_definitions_status_check
        CHECK (status IN ('active', 'archived'))
);

CREATE INDEX IF NOT EXISTS idx_cloud_agent_definitions_owner_updated
    ON cloud_agent_definitions(owner_account_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_cloud_agent_definitions_owner_status
    ON cloud_agent_definitions(owner_account_id, status, updated_at DESC);
