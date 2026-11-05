-- Usage notices (docs/development/resource-pools.md#usage-and-limits).
--
-- One row per notice that was shown, so each is shown once per window: the
-- line in a conversation whose System agent pass a pool refused ('paused',
-- with the limit that was reached), and the notices to an organization's
-- owners when its pool passes 75% and 90% of a daily cap. A notice is
-- written with ON CONFLICT DO NOTHING, and only the writer that inserted the
-- row posts or sends it, so concurrent passes never show it twice.
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS cloud_usage_notices (
    scope_kind TEXT NOT NULL CHECK (scope_kind IN ('conversation', 'organization')),
    scope_id TEXT NOT NULL,
    pool_id TEXT NOT NULL,
    usage_day DATE NOT NULL,
    notice TEXT NOT NULL CHECK (notice IN ('paused', 'threshold_75', 'threshold_90')),
    reached TEXT CHECK (reached IN ('daily_limit', 'spend_limit', 'stopped')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (scope_kind, scope_id, pool_id, usage_day, notice)
);

-- Old days are pruned with pool usage.
CREATE INDEX IF NOT EXISTS idx_cloud_usage_notices_day
    ON cloud_usage_notices (usage_day);
