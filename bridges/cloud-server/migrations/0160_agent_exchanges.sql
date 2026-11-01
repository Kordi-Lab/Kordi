-- Delivery and processing are independent of human chat read cursors.
CREATE TABLE cloud_agent_exchanges (
    exchange_id UUID PRIMARY KEY,
    parent_run_id TEXT NOT NULL REFERENCES cloud_agent_fallback_runs(run_id),
    root_run_id TEXT NOT NULL REFERENCES cloud_agent_fallback_runs(run_id),
    request_key TEXT NOT NULL CHECK (length(request_key) BETWEEN 1 AND 256),
    target_owner_id TEXT NOT NULL REFERENCES cloud_accounts(account_id),
    target_agent_id TEXT NOT NULL,
    request_text TEXT NOT NULL,
    target_run_id TEXT UNIQUE REFERENCES cloud_agent_fallback_runs(run_id),
    resume_run_id TEXT UNIQUE REFERENCES cloud_agent_fallback_runs(run_id),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','reply_received','resuming','completed','failed','cancelled','timed_out')),
    response_text TEXT,
    request_message_id UUID,
    response_message_id UUID,
    checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deadline_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '10 minutes',
    received_at TIMESTAMPTZ,
    processed_at TIMESTAMPTZ,
    UNIQUE (parent_run_id, request_key)
);
CREATE INDEX cloud_agent_exchanges_pending ON cloud_agent_exchanges(checked_at,created_at)
    WHERE processed_at IS NULL;
