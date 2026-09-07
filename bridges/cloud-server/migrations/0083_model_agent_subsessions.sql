-- Execution records are not conversations or user-created forks.
CREATE TABLE cloud_agent_subsessions (
    subsession_id UUID PRIMARY KEY,
    parent_conversation_id UUID NOT NULL REFERENCES cloud_chat_conversations(conversation_id) ON DELETE CASCADE,
    parent_session_id TEXT NOT NULL,
    parent_request_id TEXT NOT NULL,
    owner_account_id TEXT NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    publisher_device_id TEXT NOT NULL,
    execution_backend TEXT NOT NULL DEFAULT 'desktop' CHECK (execution_backend IN ('desktop', 'cloud')),
    spawn_key TEXT UNIQUE,
    agent_id TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('running', 'done', 'failed', 'stopped')),
    messages JSONB NOT NULL DEFAULT '[]'::jsonb,
    version BIGINT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX cloud_agent_subsessions_parent ON cloud_agent_subsessions(parent_conversation_id, updated_at DESC);

ALTER TABLE cloud_agent_fallback_runs
    ADD COLUMN parent_run_id TEXT REFERENCES cloud_agent_fallback_runs(run_id),
    ADD COLUMN subsession_id UUID UNIQUE REFERENCES cloud_agent_subsessions(subsession_id),
    ADD COLUMN subsession_write_scope JSONB NOT NULL DEFAULT '[]'::jsonb;
