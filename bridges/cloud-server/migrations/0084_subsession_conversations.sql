ALTER TABLE cloud_agent_subsessions
    ADD COLUMN heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN activity JSONB NOT NULL DEFAULT '{"tools":[]}'::jsonb;

ALTER TABLE cloud_agent_fallback_runs DROP CONSTRAINT cloud_agent_fallback_runs_subsession_id_key;
CREATE INDEX cloud_agent_runs_subsession_queue ON cloud_agent_fallback_runs(subsession_id, created_at);

CREATE TABLE cloud_agent_subsession_chat (
    message_id UUID PRIMARY KEY,
    subsession_id UUID NOT NULL REFERENCES cloud_agent_subsessions(subsession_id) ON DELETE CASCADE,
    sender_account_id TEXT NOT NULL REFERENCES cloud_accounts(account_id),
    sequence BIGSERIAL UNIQUE,
    text TEXT NOT NULL,
    mentions JSONB NOT NULL DEFAULT '[]'::jsonb,
    run_id TEXT UNIQUE REFERENCES cloud_agent_fallback_runs(run_id),
    response_text TEXT NOT NULL DEFAULT '',
    activity JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX cloud_agent_subsession_chat_order ON cloud_agent_subsession_chat(subsession_id, sequence);
