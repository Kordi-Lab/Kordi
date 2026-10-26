-- Indexes the personal agent sweep reads (docs/development/personal-agent.md),
-- on existing tables, apart from 0156 so that migration stays short. The
-- runner applies each migration in one transaction, so these are plain
-- CREATE INDEX: writes to the two tables wait while they build, and a busy
-- lock fails the migration fast instead of queueing writes behind it.
SET LOCAL lock_timeout = '5s';

-- Polls can store old `occurred_at` values, so the sweep reads events by
-- the time the server received them.
CREATE INDEX IF NOT EXISTS idx_cloud_connector_events_connector_received
    ON cloud_connector_events (connector_id, received_at);

-- The daily evaluation cap counts an agent's evaluation runs.
CREATE INDEX IF NOT EXISTS idx_cloud_agent_fallback_runs_personal_agent_eval
    ON cloud_agent_fallback_runs (execution_agent_id, created_at)
    WHERE starts_with(run_id, 'personal_agent_eval_');
