ALTER TABLE cloud_agent_definitions
    ADD COLUMN IF NOT EXISTS source_agent_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_agent_definitions_owner_source_active
    ON cloud_agent_definitions(owner_account_id, source_agent_id)
    WHERE source_agent_id IS NOT NULL
      AND status = 'active'
      AND is_system_managed = FALSE;

