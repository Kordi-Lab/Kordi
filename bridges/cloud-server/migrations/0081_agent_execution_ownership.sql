-- A run is shared by desktop and cloud; retries cannot create another executor.
ALTER TABLE cloud_agent_fallback_runs
    ADD COLUMN execution_backend TEXT NOT NULL DEFAULT 'cloud'
        CHECK (execution_backend IN ('cloud', 'desktop')),
    ADD COLUMN execution_agent_id TEXT;
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
CREATE UNIQUE INDEX cloud_agent_request_executor
    ON cloud_agent_fallback_runs(owner_account_id, execution_agent_id, request_message_id);

CREATE TABLE cloud_agent_desktop_capabilities (
    device_id TEXT NOT NULL REFERENCES cloud_devices(device_id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (device_id, agent_id)
);
