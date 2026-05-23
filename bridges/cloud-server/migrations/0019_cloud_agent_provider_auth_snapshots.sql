-- A draft #479 implementation created a read-only provider-auth table with
-- this same name and an incompatible plaintext JSON shape. Preserve that
-- data under a legacy name, then create the encrypted snapshot table used by
-- the Cloud sandbox fallback runtime.
DO $$
BEGIN
    IF to_regclass('public.cloud_agent_provider_auth_snapshots') IS NOT NULL
       AND NOT EXISTS (
           SELECT 1
           FROM information_schema.columns
           WHERE table_schema = 'public'
             AND table_name = 'cloud_agent_provider_auth_snapshots'
             AND column_name = 'snapshot_id'
       ) THEN
        ALTER TABLE cloud_agent_provider_auth_snapshots
            RENAME TO cloud_agent_provider_auth_snapshots_legacy_readonly;
        IF EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'cloud_agent_provider_auth_snapshots_pkey'
        ) THEN
            ALTER TABLE cloud_agent_provider_auth_snapshots_legacy_readonly
                RENAME CONSTRAINT cloud_agent_provider_auth_snapshots_pkey
                TO cloud_agent_provider_auth_snapshots_legacy_readonly_pkey;
        END IF;
        IF to_regclass('public.idx_cloud_agent_provider_auth_snapshots_updated') IS NOT NULL THEN
            ALTER INDEX idx_cloud_agent_provider_auth_snapshots_updated
                RENAME TO idx_cloud_agent_provider_auth_snapshots_legacy_updated;
        END IF;
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS cloud_agent_provider_auth_snapshots (
    snapshot_id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    device_id TEXT NOT NULL REFERENCES cloud_devices(device_id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    auth_choice TEXT NOT NULL,
    encrypted_payload BYTEA NOT NULL,
    encryption_key_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    revoked_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_agent_provider_auth_snapshots_one_active
    ON cloud_agent_provider_auth_snapshots(account_id, provider, auth_choice)
    WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_cloud_agent_provider_auth_snapshots_account_active
    ON cloud_agent_provider_auth_snapshots(account_id, provider, auth_choice, created_at)
    WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS cloud_agent_provider_auth_snapshot_audit (
    audit_id TEXT PRIMARY KEY,
    snapshot_id TEXT NOT NULL REFERENCES cloud_agent_provider_auth_snapshots(snapshot_id) ON DELETE CASCADE,
    account_id TEXT NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    run_id TEXT,
    action TEXT NOT NULL CHECK (action IN ('created', 'used', 'revoked')),
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cloud_agent_provider_auth_snapshot_audit_snapshot_created
    ON cloud_agent_provider_auth_snapshot_audit(snapshot_id, created_at);
