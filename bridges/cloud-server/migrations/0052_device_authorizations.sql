-- First-class installation/device authorization metadata and idempotent
-- device-management operations. Existing protocol-v1 device rows remain valid
-- during rolling client upgrades; current clients register real P-256 keys.

ALTER TABLE cloud_devices
    ADD COLUMN IF NOT EXISTS device_key_algorithm TEXT NOT NULL DEFAULT 'legacy',
    ADD COLUMN IF NOT EXISTS device_platform TEXT,
    ADD COLUMN IF NOT EXISTS os_version TEXT,
    ADD COLUMN IF NOT EXISTS app_version TEXT,
    ADD COLUMN IF NOT EXISTS authorization_state TEXT NOT NULL DEFAULT 'confirmed',
    ADD COLUMN IF NOT EXISTS confirmed_at TEXT,
    ADD COLUMN IF NOT EXISTS last_sync_at TEXT;

UPDATE cloud_devices
SET confirmed_at = COALESCE(confirmed_at, created_at)
WHERE authorization_state = 'confirmed';

ALTER TABLE cloud_devices
    ADD CONSTRAINT cloud_devices_authorization_state_check
    CHECK (authorization_state IN ('pending_review', 'confirmed'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_devices_account_public_key
    ON cloud_devices(account_id, device_public_key);

ALTER TABLE cloud_oauth_states
    ADD COLUMN IF NOT EXISTS device_name TEXT,
    ADD COLUMN IF NOT EXISTS device_public_key TEXT,
    ADD COLUMN IF NOT EXISTS device_key_algorithm TEXT,
    ADD COLUMN IF NOT EXISTS device_platform TEXT,
    ADD COLUMN IF NOT EXISTS device_os_version TEXT,
    ADD COLUMN IF NOT EXISTS device_app_version TEXT;

CREATE TABLE IF NOT EXISTS cloud_device_operations (
    account_id          TEXT NOT NULL
                        REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    client_operation_id UUID NOT NULL,
    operation_kind      TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    result              JSONB NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, client_operation_id)
);

CREATE INDEX IF NOT EXISTS idx_cloud_device_operations_created
    ON cloud_device_operations(created_at);
