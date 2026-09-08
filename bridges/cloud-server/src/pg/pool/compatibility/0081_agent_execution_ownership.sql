-- A run is shared by desktop and cloud; retries cannot create another executor.
ALTER TABLE cloud_agent_fallback_runs
    ADD COLUMN execution_backend TEXT NOT NULL DEFAULT 'cloud'
        CHECK (execution_backend IN ('cloud', 'desktop')),
    ADD COLUMN execution_agent_id TEXT,
    ADD COLUMN legacy_duplicate BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE cloud_agent_fallback_runs
SET execution_agent_id = 'cloud-agent:' || owner_account_id;
ALTER TABLE cloud_agent_fallback_runs ALTER COLUMN execution_agent_id SET NOT NULL;
CREATE FUNCTION set_execution_agent_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.execution_agent_id := COALESCE(NEW.execution_agent_id, 'cloud-agent:' || NEW.owner_account_id);
    RETURN NEW;
END;
$$;
CREATE TRIGGER cloud_agent_execution_identity BEFORE INSERT ON cloud_agent_fallback_runs
    FOR EACH ROW EXECUTE FUNCTION set_execution_agent_identity();
-- Keep every historical run and its events/response. A live executor wins;
-- otherwise prefer the latest completed result, with a stable tie-breaker.
WITH ranked AS (
    SELECT run_id, row_number() OVER (
        PARTITION BY owner_account_id, execution_agent_id, request_message_id
        ORDER BY (status IN ('queued','leased','running')) DESC,
                 (status = 'completed') DESC, created_at DESC, run_id DESC
    ) AS ordinal FROM cloud_agent_fallback_runs
)
UPDATE cloud_agent_fallback_runs run SET legacy_duplicate = ranked.ordinal > 1
FROM ranked WHERE ranked.run_id = run.run_id AND ranked.ordinal > 1;
-- Multiple live executors need to finish before upgrading; never cancel one
-- or rewrite its history just to make the migration pass.
ALTER TABLE cloud_agent_fallback_runs ADD CONSTRAINT cloud_agent_legacy_duplicate_terminal
    CHECK (NOT legacy_duplicate OR status IN ('completed','failed','cancelled'));
CREATE UNIQUE INDEX cloud_agent_request_executor_current
    ON cloud_agent_fallback_runs(owner_account_id, execution_agent_id, request_message_id)
    WHERE NOT legacy_duplicate;

CREATE TABLE cloud_agent_desktop_capabilities (
    device_id TEXT NOT NULL REFERENCES cloud_devices(device_id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (device_id, agent_id)
);
