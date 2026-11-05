-- When each pool's worker last asked for a run
-- (docs/development/resource-pools.md, "Members' personal work").
--
-- Every server replica writes here on authenticated lease requests, at most
-- about once per pool every few seconds, and reads it when routing a
-- member's personal work to a covering pool, so a replica that did not
-- receive the worker's requests still sees that the worker is running. One
-- row per pool; nothing here names a person or a run.
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS cloud_pool_worker_sightings (
    pool_id TEXT PRIMARY KEY,
    last_seen_at TIMESTAMPTZ NOT NULL
);
