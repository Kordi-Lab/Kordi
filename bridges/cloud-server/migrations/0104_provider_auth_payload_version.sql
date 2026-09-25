-- Version of each snapshot's encrypted payload. A token refresh writes only
-- when the version it read is unchanged, so it cannot overwrite a concurrent
-- change to the same saved account.
ALTER TABLE cloud_agent_provider_auth_snapshots
    ADD COLUMN IF NOT EXISTS payload_version BIGINT NOT NULL DEFAULT 0;
