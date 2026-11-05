-- Device code sign-in (RFC 8628) for hosts without a usable browser, such as
-- a remote Mac reached over SSH. Additive only.
--
-- The device asks for a code pair, shows the short user code, and polls with
-- the long device code. A person signed in on the web types the user code on
-- the approval page and approves or denies. Only SHA-256 hashes of both codes
-- are stored. A row stays for a day after it expires so a second redemption
-- of a used device code can be detected and its sign-in revoked.
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS cloud_device_authorizations (
    device_code_hash     TEXT PRIMARY KEY,
    user_code_hash       TEXT NOT NULL UNIQUE,
    client_id            TEXT NOT NULL,
    -- What the device reported about itself, shown on the approval page and
    -- used to register the device when the code is redeemed.
    device_name          TEXT,
    device_platform      TEXT,
    device_os_version    TEXT,
    device_app_version   TEXT,
    device_public_key    TEXT,
    device_key_algorithm TEXT,
    -- Where the code request came from, as the server saw it.
    requester_ip         TEXT,
    approximate_location TEXT,
    status               TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'approved', 'denied', 'consumed')),
    denied_reason        TEXT,
    account_id           TEXT REFERENCES cloud_accounts (account_id) ON DELETE CASCADE,
    created_at           TIMESTAMPTZ NOT NULL,
    expires_at           TIMESTAMPTZ NOT NULL,
    decided_at           TIMESTAMPTZ,
    consumed_at          TIMESTAMPTZ,
    -- Polling: the device must wait poll_interval_secs between polls. Each
    -- early poll answers slow_down and adds five seconds.
    poll_interval_secs   INTEGER NOT NULL DEFAULT 5 CHECK (poll_interval_secs BETWEEN 1 AND 120),
    last_polled_at       TIMESTAMPTZ,
    sign_in_id           TEXT REFERENCES cloud_app_sign_ins (sign_in_id) ON DELETE SET NULL,
    CONSTRAINT cloud_device_authorizations_decision_check
        CHECK ((status = 'pending') = (decided_at IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_cloud_device_authorizations_expiry
    ON cloud_device_authorizations (expires_at);

CREATE INDEX IF NOT EXISTS idx_cloud_device_authorizations_account
    ON cloud_device_authorizations (account_id)
    WHERE account_id IS NOT NULL;

-- A team organization created from deployment configuration carries its
-- configuration id. This matches the organization admission migration, so
-- either one may run first.
ALTER TABLE cloud_organizations
    ADD COLUMN IF NOT EXISTS config_id TEXT;

-- Whether members may sign in with a device code. NULL follows the default:
-- allowed for personal organizations and for team organizations people
-- created themselves, off for configured organizations until an admin turns
-- it on.
ALTER TABLE cloud_organizations
    ADD COLUMN IF NOT EXISTS device_code_sign_in BOOLEAN;
