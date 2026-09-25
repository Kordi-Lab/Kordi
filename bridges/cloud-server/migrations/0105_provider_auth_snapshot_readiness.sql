-- Readiness facts copied from each snapshot's payload at publish and refresh
-- time, so listings can tell when an access-only account must be reconnected.
ALTER TABLE cloud_agent_provider_auth_snapshots
    ADD COLUMN IF NOT EXISTS expires_at_ms BIGINT NULL,
    ADD COLUMN IF NOT EXISTS refreshable BOOLEAN NOT NULL DEFAULT false;
