ALTER TABLE cloud_agent_provider_auth_snapshots
    ADD COLUMN IF NOT EXISTS model_hint TEXT;
