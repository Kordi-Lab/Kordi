-- Runs of resource pools whose work executes on the pool's own worker
-- (docs/development/resource-pools.md, "Pool workers").
--
-- A System agent or Grounding run of a pool with executor pool_worker gets one
-- row here in the transaction that queues it. The control plane's runners
-- never lease a run with a row; only a worker that proves the pool's
-- workload identity can. Each lease issues a new one-time token, stored only
-- as its SHA-256 hash, that the worker presents on every later call for the
-- run, so a lease taken over after it expired locks the previous worker out.
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS cloud_pool_worker_runs (
    run_id TEXT PRIMARY KEY
        REFERENCES cloud_agent_fallback_runs (run_id) ON DELETE CASCADE,
    pool_id TEXT NOT NULL,
    feature TEXT NOT NULL CHECK (feature IN ('system_agent', 'grounding')),
    worker_id TEXT,
    lease_token_hash TEXT,
    leased_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A worker looks for its pool's oldest runs.
CREATE INDEX IF NOT EXISTS idx_cloud_pool_worker_runs_pool
    ON cloud_pool_worker_runs (pool_id, created_at);
