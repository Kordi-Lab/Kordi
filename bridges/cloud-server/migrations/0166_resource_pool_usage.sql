-- Daily usage of resource pools (docs/development/resource-pools.md).
--
-- cloud_resource_pool_usage holds one counter row per pool, UTC day, feature
-- and scope: a conversation for System agent runs, a person for Grounding
-- runs, and the empty scope '' with feature '*' for the whole pool. A run is
-- admitted by an upsert that increments a counter only while it is below the
-- limit, so concurrent admissions never pass a limit.
--
-- cloud_resource_pool_reservations records each admitted run once, keyed by
-- its run id, so a retried admission is not counted twice and settlement is
-- idempotent: a reservation moves from 'reserved' to 'consumed' or 'released'
-- exactly once, and only a release gives its run back to the counters.
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS cloud_resource_pool_usage (
    pool_id TEXT NOT NULL,
    usage_day DATE NOT NULL,
    feature TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    runs BIGINT NOT NULL DEFAULT 0 CHECK (runs >= 0),
    spend_micros BIGINT NOT NULL DEFAULT 0 CHECK (spend_micros >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (pool_id, usage_day, feature, scope_id)
);

CREATE TABLE IF NOT EXISTS cloud_resource_pool_reservations (
    run_id TEXT PRIMARY KEY,
    pool_id TEXT NOT NULL,
    usage_day DATE NOT NULL,
    feature TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    organization_id TEXT,
    spend_micros BIGINT NOT NULL DEFAULT 0 CHECK (spend_micros >= 0),
    state TEXT NOT NULL DEFAULT 'reserved'
        CHECK (state IN ('reserved', 'consumed', 'released')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    settled_at TIMESTAMPTZ
);

-- Old days are pruned by usage_day.
CREATE INDEX IF NOT EXISTS idx_cloud_resource_pool_usage_day
    ON cloud_resource_pool_usage (usage_day);
CREATE INDEX IF NOT EXISTS idx_cloud_resource_pool_reservations_day
    ON cloud_resource_pool_reservations (usage_day);
