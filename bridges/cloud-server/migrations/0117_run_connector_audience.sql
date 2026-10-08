-- Connectors PR 5 (issue 1712): who can read a run's output. Connector data
-- about other people reaches a run only when its audience is the owner alone.
-- Existing and unlabeled runs are shared runs, so they receive no connector
-- tools (fail closed).

ALTER TABLE cloud_agent_fallback_runs
    ADD COLUMN connector_audience TEXT NOT NULL DEFAULT 'shared'
        CHECK (connector_audience IN ('owner_private', 'shared'));
