-- Proactive agents (docs/development/proactive-agent.md). An owned agent can
-- watch the group conversations its owner is in and ask the owner before it
-- offers help. The setting is off by default; existing agents stay off.
ALTER TABLE cloud_agent_definitions
    ADD COLUMN IF NOT EXISTS proactive_json JSONB NOT NULL DEFAULT '{"enabled":false}';

-- One sweep row per agent and group conversation: how far the agent has read,
-- which evaluation is in flight, a bounded retry schedule, and the cooldown
-- after an offer.
CREATE TABLE IF NOT EXISTS cloud_agent_proactive_state (
    agent_id         TEXT NOT NULL
        REFERENCES cloud_agent_definitions (agent_id) ON DELETE CASCADE,
    conversation_id  UUID NOT NULL
        REFERENCES cloud_chat_conversations (conversation_id) ON DELETE CASCADE,
    seen_sequence    BIGINT NOT NULL DEFAULT 0,
    active_run_id    TEXT,
    retry_after      TIMESTAMPTZ NOT NULL DEFAULT now(),
    cooldown_until   TIMESTAMPTZ NOT NULL DEFAULT now(),
    attempts         INTEGER NOT NULL DEFAULT 0,
    last_error       TEXT,
    checked_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (agent_id, conversation_id)
);

CREATE INDEX IF NOT EXISTS idx_cloud_agent_proactive_state_due
    ON cloud_agent_proactive_state (checked_at)
    WHERE active_run_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_agent_proactive_state_active_run
    ON cloud_agent_proactive_state (active_run_id)
    WHERE active_run_id IS NOT NULL;

-- Offers waiting for, or past, the owner's decision.
CREATE TABLE IF NOT EXISTS cloud_agent_proactive_proposals (
    proposal_id        TEXT PRIMARY KEY,
    agent_id           TEXT NOT NULL
        REFERENCES cloud_agent_definitions (agent_id) ON DELETE CASCADE,
    owner_account_id   TEXT NOT NULL
        REFERENCES cloud_accounts (account_id) ON DELETE CASCADE,
    conversation_id    UUID NOT NULL
        REFERENCES cloud_chat_conversations (conversation_id) ON DELETE CASCADE,
    session_id         TEXT NOT NULL,
    trigger_message_id TEXT NOT NULL,
    evidence_json      JSONB NOT NULL DEFAULT '[]',
    problem            TEXT NOT NULL,
    offer              TEXT NOT NULL,
    plan               TEXT NOT NULL,
    status             TEXT NOT NULL DEFAULT 'pending',
    evaluation_run_id  TEXT NOT NULL UNIQUE,
    run_id             TEXT UNIQUE,
    card_message_id    TEXT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    decided_at         TIMESTAMPTZ,
    expires_at         TIMESTAMPTZ NOT NULL,
    CONSTRAINT cloud_agent_proactive_proposals_status_check
        CHECK (status IN ('pending', 'approved', 'declined', 'expired', 'running', 'done', 'failed'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_agent_proactive_proposals_one_pending
    ON cloud_agent_proactive_proposals (agent_id, conversation_id)
    WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_cloud_agent_proactive_proposals_agent_created
    ON cloud_agent_proactive_proposals (agent_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_cloud_agent_proactive_proposals_open
    ON cloud_agent_proactive_proposals (status, expires_at)
    WHERE status IN ('pending', 'approved', 'running');

-- The daily evaluation cap counts an agent's evaluation runs.
CREATE INDEX IF NOT EXISTS idx_cloud_agent_fallback_runs_proactive_eval
    ON cloud_agent_fallback_runs (execution_agent_id, created_at)
    WHERE starts_with(run_id, 'proactive_eval_');
