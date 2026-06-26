ALTER TABLE cloud_agent_definitions
    ADD COLUMN IF NOT EXISTS is_system_managed BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_cloud_agent_definitions_system_managed
    ON cloud_agent_definitions(is_system_managed, status, agent_id)
    WHERE is_system_managed = TRUE;
