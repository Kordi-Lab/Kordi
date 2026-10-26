-- Personal agents (docs/development/personal-agent.md). Every owned agent has
-- one personal session with its owner, and with the agent's Proactive setting
-- on it may write there first about new connector events. `agent_id` is a
-- definition id or the default agent's synthetic id `cloud-agent:<account>`,
-- so no table has a foreign key to the agent; the owner's row cleans up, and
-- archiving a definition deletes its rows.
--
-- Only new, empty tables: the foreign keys briefly lock the referenced tables,
-- so a busy lock fails this migration fast instead of queueing writes behind
-- it. The indexes on existing tables are in 0157.
SET LOCAL lock_timeout = '5s';

-- The Proactive setting (`personalAgent.proactive`). No row is off.
CREATE TABLE IF NOT EXISTS cloud_personal_agent_settings (
    agent_id         TEXT PRIMARY KEY,
    owner_account_id TEXT NOT NULL
        REFERENCES cloud_accounts (account_id) ON DELETE CASCADE,
    proactive        BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cloud_personal_agent_settings_on
    ON cloud_personal_agent_settings (owner_account_id)
    WHERE proactive;

-- The personal session of each agent: one `kind = 'ai'` conversation with
-- the owner as its only member.
CREATE TABLE IF NOT EXISTS cloud_personal_agent_sessions (
    agent_id         TEXT PRIMARY KEY,
    owner_account_id TEXT NOT NULL
        REFERENCES cloud_accounts (account_id) ON DELETE CASCADE,
    conversation_id  UUID NOT NULL UNIQUE
        REFERENCES cloud_chat_conversations (conversation_id) ON DELETE CASCADE,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cloud_personal_agent_sessions_owner
    ON cloud_personal_agent_sessions (owner_account_id);

-- Sweep state per agent: the newest connector event it has looked at, as
-- (`received_at`, `event_id`); when the setting was turned on; the evaluation
-- in flight and the cursor it will move to; a bounded retry schedule; and the
-- cooldown after a message.
CREATE TABLE IF NOT EXISTS cloud_personal_agent_state (
    agent_id               TEXT PRIMARY KEY,
    owner_account_id       TEXT NOT NULL
        REFERENCES cloud_accounts (account_id) ON DELETE CASCADE,
    cursor_received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    cursor_event_id        TEXT NOT NULL DEFAULT '',
    enabled_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    active_run_id          TEXT,
    run_cursor_received_at TIMESTAMPTZ,
    run_cursor_event_id    TEXT,
    retry_after            TIMESTAMPTZ NOT NULL DEFAULT now(),
    cooldown_until         TIMESTAMPTZ NOT NULL DEFAULT now(),
    attempts               INTEGER NOT NULL DEFAULT 0,
    last_error             TEXT,
    memory_searches        INTEGER NOT NULL DEFAULT 0,
    checked_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_personal_agent_state_active_run
    ON cloud_personal_agent_state (active_run_id)
    WHERE active_run_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_cloud_personal_agent_state_due
    ON cloud_personal_agent_state (checked_at)
    WHERE active_run_id IS NULL;

-- Messages an agent posted on its own: the repeat check, the daily cap, and
-- the record of which events each message was about.
CREATE TABLE IF NOT EXISTS cloud_personal_agent_messages (
    run_id           TEXT PRIMARY KEY,
    agent_id         TEXT NOT NULL,
    owner_account_id TEXT NOT NULL
        REFERENCES cloud_accounts (account_id) ON DELETE CASCADE,
    message_id       UUID NOT NULL,
    text             TEXT NOT NULL,
    event_ids        TEXT[] NOT NULL DEFAULT '{}',
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cloud_personal_agent_messages_agent_created
    ON cloud_personal_agent_messages (agent_id, created_at DESC);
