-- Browser sign-in for native apps: authorization codes with PKCE and
-- rotating refresh tokens. Additive only; existing sessions are unchanged.
--
-- Registered clients live in server configuration, not in this schema, so
-- client_id columns are plain text checked by the server.

-- One sign-in of one app on one device. Every refresh token rotated from the
-- same authorization code belongs to the same sign-in; revoking it revokes
-- every refresh token and access token it issued.
CREATE TABLE cloud_app_sign_ins (
    sign_in_id        TEXT PRIMARY KEY,
    account_id        TEXT NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    device_id         TEXT NOT NULL REFERENCES cloud_devices(device_id) ON DELETE CASCADE,
    client_id         TEXT NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL,
    last_refreshed_at TIMESTAMPTZ NOT NULL,
    revoked_at        TIMESTAMPTZ,
    revoked_reason    TEXT
);

CREATE INDEX idx_cloud_app_sign_ins_account
    ON cloud_app_sign_ins (account_id, revoked_at);

-- Single-use authorization codes. Only a hash of the code is stored. A code
-- stays after use so a second exchange can be detected and its sign-in
-- revoked.
CREATE TABLE cloud_app_authorization_codes (
    code_hash      TEXT PRIMARY KEY,
    account_id     TEXT NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    client_id      TEXT NOT NULL,
    redirect_uri   TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    delivery       TEXT NOT NULL CHECK (delivery IN ('redirect', 'display')),
    created_at     TIMESTAMPTZ NOT NULL,
    expires_at     TIMESTAMPTZ NOT NULL,
    consumed_at    TIMESTAMPTZ,
    sign_in_id     TEXT REFERENCES cloud_app_sign_ins(sign_in_id) ON DELETE SET NULL
);

CREATE INDEX idx_cloud_app_authorization_codes_expiry
    ON cloud_app_authorization_codes (expires_at);

-- Refresh tokens, hashed. A token is used once: refreshing marks it rotated
-- and issues the next one. Presenting a rotated token again revokes the
-- whole sign-in.
CREATE TABLE cloud_app_refresh_tokens (
    token_hash  TEXT PRIMARY KEY,
    sign_in_id  TEXT NOT NULL REFERENCES cloud_app_sign_ins(sign_in_id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    rotated_at  TIMESTAMPTZ
);

CREATE INDEX idx_cloud_app_refresh_tokens_sign_in
    ON cloud_app_refresh_tokens (sign_in_id);

-- Access tokens are ordinary session rows so the existing session middleware
-- accepts them. A session issued by a browser sign-in carries its sign-in
-- and keeps a fixed expiry instead of sliding forward on use.
ALTER TABLE cloud_refresh_tokens
    ADD COLUMN IF NOT EXISTS app_sign_in_id TEXT
        REFERENCES cloud_app_sign_ins(sign_in_id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_cloud_refresh_tokens_app_sign_in
    ON cloud_refresh_tokens (app_sign_in_id)
    WHERE app_sign_in_id IS NOT NULL;

-- A rotated refresh token remembers its successor for a short grace period,
-- so a retried or concurrent refresh receives the same successor instead of
-- revoking the sign-in. The successor tokens are derived from the presented
-- token and this salt; only their hashes are stored.
ALTER TABLE cloud_app_refresh_tokens
    ADD COLUMN IF NOT EXISTS successor_salt TEXT,
    ADD COLUMN IF NOT EXISTS successor_token_hash TEXT;

-- When a device was last revoked. Re-authorizing the device clears
-- revoked_at, so this keeps sign-ins created before the revocation from
-- coming back. A trigger sets it on every revocation path.
ALTER TABLE cloud_devices
    ADD COLUMN IF NOT EXISTS last_revoked_at TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION cloud_devices_record_revocation() RETURNS trigger AS $$
BEGIN
    IF NEW.revoked_at IS NOT NULL AND OLD.revoked_at IS NULL THEN
        NEW.last_revoked_at := now();
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS cloud_devices_record_revocation ON cloud_devices;
CREATE TRIGGER cloud_devices_record_revocation
    BEFORE UPDATE OF revoked_at ON cloud_devices
    FOR EACH ROW EXECUTE FUNCTION cloud_devices_record_revocation();

-- A web provider sign-in is bound to the browser that started it: the
-- browser holds a random value in a short-lived cookie and the state stores
-- its SHA-256. The state may also name the cookie session it replaces.
ALTER TABLE cloud_oauth_states
    ADD COLUMN IF NOT EXISTS browser_binding_hash TEXT,
    ADD COLUMN IF NOT EXISTS replaces_session_token_id TEXT;
