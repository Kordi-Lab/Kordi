CREATE TABLE IF NOT EXISTS cloud_device_presence (
    device_id         TEXT PRIMARY KEY REFERENCES cloud_devices(device_id) ON DELETE CASCADE,
    account_id        TEXT NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    state             TEXT NOT NULL CHECK (state IN ('online', 'offline')),
    last_heartbeat_at TEXT,
    last_offline_at   TEXT,
    updated_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cloud_device_presence_account
    ON cloud_device_presence (account_id, state, last_heartbeat_at);

CREATE INDEX IF NOT EXISTS idx_cloud_device_presence_heartbeat
    ON cloud_device_presence (state, last_heartbeat_at);
