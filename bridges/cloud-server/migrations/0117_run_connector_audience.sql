-- Connectors PR 5 (issue 1712): who can read a run's output. Connector data
-- about other people reaches a run only when its audience is the owner alone.
-- Existing and unlabeled runs are shared runs, so they receive no connector
-- tools (fail closed).

ALTER TABLE cloud_agent_fallback_runs
    ADD COLUMN connector_audience TEXT NOT NULL DEFAULT 'shared'
        CHECK (connector_audience IN ('owner_private', 'shared'));

-- Tools delivered before the audience existed were chosen without it. A run
-- that has not finished gives them up and, on its next lease, receives the
-- set for its audience (shared, so none). The broker refuses any call for a
-- tool no longer on the run.
UPDATE cloud_agent_fallback_runs
SET connector_tools_json = '[]'::jsonb,
    connector_tools_delivered_at = NULL
WHERE status IN ('queued', 'leased', 'running');
