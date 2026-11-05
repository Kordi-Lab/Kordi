-- Runs of resource pools whose work executes on the pool's own worker
-- (docs/development/resource-pools.md, "Pool workers").
--
-- A System agent or Grounding run of a pool with executor pool_worker gets one
-- row here in the transaction that queues it. The control plane's runners
-- never lease a run with a row; only a worker that proves the pool's
-- workload identity can. Each lease issues a new one-time token, stored only
-- as its SHA-256 hash and cleared when the worker completes or fails the run,
-- so a lease taken over after it expired, or a replayed call, is refused.
-- lease_count caps how often one run is leased, so a run that keeps failing
-- on a worker cannot be retried without end. Rows are deleted once their run
-- has ended.
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS cloud_pool_worker_runs (
    run_id TEXT PRIMARY KEY
        REFERENCES cloud_agent_fallback_runs (run_id) ON DELETE CASCADE,
    pool_id TEXT NOT NULL,
    feature TEXT NOT NULL CHECK (feature IN ('system_agent', 'grounding')),
    worker_id TEXT,
    lease_token_hash TEXT,
    lease_count INTEGER NOT NULL DEFAULT 0 CHECK (lease_count >= 0),
    leased_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A worker looks for its pool's oldest runs.
CREATE INDEX IF NOT EXISTS idx_cloud_pool_worker_runs_pool
    ON cloud_pool_worker_runs (pool_id, created_at);
