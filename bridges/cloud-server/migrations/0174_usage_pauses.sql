-- Usage pauses (docs/development/resource-pools.md#usage-and-limits).
--
-- When a resource pool refuses a System agent pass, the conversation's pause
-- is recorded once per pool and UTC day: which limit refused it, why, and
-- when, so Settings can show "Paused since 14:20". Nothing is posted into
-- the conversation. Rows are written with ON CONFLICT DO NOTHING, so the
-- first refusal of a window is kept and later ones change nothing.
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS cloud_usage_pauses (
    pool_id TEXT NOT NULL,
    usage_day DATE NOT NULL,
    conversation_id TEXT NOT NULL,
    organization_id TEXT,
    limit_id TEXT NOT NULL CHECK (limit_id IN (
        'conversation.system_agent_runs', 'pool.runs', 'pool.spend', 'pool.stopped'
    )),
    reached TEXT NOT NULL CHECK (reached IN ('daily_limit', 'spend_limit', 'stopped')),
    paused_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (pool_id, usage_day, conversation_id)
);

-- Old days are pruned with pool usage.
CREATE INDEX IF NOT EXISTS idx_cloud_usage_pauses_day
    ON cloud_usage_pauses (usage_day);
