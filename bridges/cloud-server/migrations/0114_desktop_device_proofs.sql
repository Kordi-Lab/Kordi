-- Single-use challenges a desktop signs with its registered device key
-- before the server returns hosted provider material for a run it executes.
-- One open challenge per execution lease; a challenge is deleted when used.
CREATE TABLE IF NOT EXISTS cloud_device_proof_challenges (
    nonce TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    device_id TEXT NOT NULL REFERENCES cloud_devices(device_id) ON DELETE CASCADE,
    run_id TEXT NOT NULL REFERENCES cloud_agent_fallback_runs(run_id) ON DELETE CASCADE,
    claim_id UUID NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (device_id, run_id, claim_id)
);

-- Readiness published by a desktop that signs device proofs. Desktops that
-- publish readiness without it are not offered runs on hosted provider
-- accounts, which the cloud runner executes instead.
ALTER TABLE cloud_agent_desktop_capabilities
    ADD COLUMN IF NOT EXISTS device_proof BOOLEAN NOT NULL DEFAULT FALSE;
