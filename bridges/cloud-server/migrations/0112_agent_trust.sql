-- Agent access settings for shared conversations. Additive only: no message,
-- membership, run, sandbox, or plan card row changes.

-- Per-conversation AI access for groups. A missing row means
-- history_scope='mentions' and pip_enabled=false.
CREATE TABLE IF NOT EXISTS cloud_chat_ai_policies (
    conversation_id UUID PRIMARY KEY
        REFERENCES cloud_chat_conversations(conversation_id) ON DELETE CASCADE,
    history_scope TEXT NOT NULL DEFAULT 'mentions'
        CHECK (history_scope IN ('mentions', 'recent')),
    pip_enabled BOOLEAN NOT NULL DEFAULT false,
    updated_by_account_id TEXT REFERENCES cloud_accounts(account_id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- "Don't let AI use my messages". Rows survive leaving, so past messages stay
-- excluded.
CREATE TABLE IF NOT EXISTS cloud_chat_ai_opt_outs (
    conversation_id UUID NOT NULL
        REFERENCES cloud_chat_conversations(conversation_id) ON DELETE CASCADE,
    account_id TEXT NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (conversation_id, account_id)
);

-- Existing groups keep PiP and move to mention-only agent context.
INSERT INTO cloud_chat_ai_policies (conversation_id, history_scope, pip_enabled)
SELECT conversation_id, 'mentions', true
FROM cloud_chat_conversations
WHERE kind = 'group'
ON CONFLICT (conversation_id) DO NOTHING;

-- Desktop executors declare the context contract they implement
-- (1 = legacy local context).
ALTER TABLE cloud_agent_desktop_capabilities
    ADD COLUMN IF NOT EXISTS context_contract SMALLINT NOT NULL DEFAULT 1;

-- Server-recorded disclosure for Kordi Cloud runs.
ALTER TABLE cloud_agent_fallback_runs
    ADD COLUMN IF NOT EXISTS disclosed_provider TEXT,
    ADD COLUMN IF NOT EXISTS disclosed_model TEXT;

-- Actions that need a person.
CREATE TABLE IF NOT EXISTS cloud_agent_pending_actions (
    action_id UUID PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN (
        'calendar_disclosure', 'plan_rsvp', 'plan_vote',
        'plan_confirm', 'plan_cancel', 'plan_reopen'
    )),
    conversation_id UUID NOT NULL
        REFERENCES cloud_chat_conversations(conversation_id) ON DELETE CASCADE,
    session_id TEXT NOT NULL,
    approver_account_id TEXT REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    proposed_by_account_id TEXT NOT NULL
        REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    run_id TEXT,
    request_message_id TEXT,
    event_id TEXT REFERENCES cloud_plan_cards(event_id) ON DELETE CASCADE,
    subject JSONB NOT NULL DEFAULT '{}'::jsonb,
    subject_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
        'pending', 'approved', 'declined', 'expired', 'superseded', 'applied'
    )),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    decided_at TIMESTAMPTZ,
    decided_by_account_id TEXT REFERENCES cloud_accounts(account_id) ON DELETE SET NULL,
    grant_expires_at TIMESTAMPTZ,
    CHECK ((kind IN ('plan_confirm', 'plan_cancel', 'plan_reopen'))
           = (approver_account_id IS NULL)),
    CHECK ((kind IN ('plan_rsvp', 'plan_vote', 'plan_confirm', 'plan_cancel', 'plan_reopen'))
           = (event_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_agent_pending_actions_open
    ON cloud_agent_pending_actions (
        kind, conversation_id, COALESCE(approver_account_id, ''),
        COALESCE(request_message_id, ''), subject_key
    )
    WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_cloud_agent_pending_actions_approver
    ON cloud_agent_pending_actions (approver_account_id, status, expires_at);
CREATE INDEX IF NOT EXISTS idx_cloud_agent_pending_actions_conversation
    ON cloud_agent_pending_actions (conversation_id, status);
CREATE INDEX IF NOT EXISTS idx_cloud_agent_pending_actions_event
    ON cloud_agent_pending_actions (event_id) WHERE event_id IS NOT NULL;
