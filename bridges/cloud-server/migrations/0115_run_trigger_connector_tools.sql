-- Connectors PR 2 (issue 1712): who started each run, and the connector tool
-- descriptors delivered with its lease. Existing and unlabeled runs are
-- background runs, so they never receive act tools (fail closed).

ALTER TABLE cloud_agent_fallback_runs
    ADD COLUMN run_trigger TEXT NOT NULL DEFAULT 'background'
        CHECK (run_trigger IN ('person_started', 'background')),
    ADD COLUMN connector_tools_json JSONB NOT NULL DEFAULT '[]'::jsonb
        CHECK (jsonb_typeof(connector_tools_json) = 'array');
