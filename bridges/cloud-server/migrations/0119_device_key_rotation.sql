-- Single-use challenges a device signs, with its registered installation key
-- and with the key that replaces it, to rotate that key. One open challenge
-- per device; a challenge is deleted when it is used.
CREATE TABLE IF NOT EXISTS cloud_device_key_rotation_challenges (
    nonce TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    device_id TEXT NOT NULL UNIQUE REFERENCES cloud_devices(device_id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
