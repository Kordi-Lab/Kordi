ALTER TABLE cloud_agent_fallback_runs
    ADD COLUMN IF NOT EXISTS provider_auth_source TEXT NOT NULL DEFAULT 'owner_snapshot';

UPDATE cloud_agent_fallback_runs
SET provider_auth_source = 'support_service'
WHERE idempotency_key LIKE 'kordi-support:%';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'cloud_agent_fallback_runs_provider_auth_source_check'
    ) THEN
        ALTER TABLE cloud_agent_fallback_runs
            ADD CONSTRAINT cloud_agent_fallback_runs_provider_auth_source_check
            CHECK (provider_auth_source IN ('owner_snapshot', 'support_service'));
    END IF;
END $$;
