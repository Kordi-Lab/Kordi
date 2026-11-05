-- Email codes for account security changes. Rules match
-- cloud_account_email_codes: one live challenge per account, ten-minute
-- expiry, five guesses, one send per minute, and five sends per hour.
--
-- cloud_account_email_change_codes: sent to the new address an account wants
-- as its primary email; `email` is that new address.
-- cloud_account_reauth_codes: sent to the current primary email so an account
-- without a password can confirm a sensitive change.
CREATE TABLE cloud_account_email_change_codes (
    account_id TEXT PRIMARY KEY REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    verification_id TEXT NOT NULL UNIQUE,
    code_mac BYTEA NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    resend_after TIMESTAMPTZ NOT NULL,
    window_started_at TIMESTAMPTZ NOT NULL,
    send_count INTEGER NOT NULL CHECK (send_count BETWEEN 1 AND 5),
    attempts_remaining INTEGER NOT NULL CHECK (attempts_remaining BETWEEN 0 AND 5),
    delivered_at TIMESTAMPTZ,
    consumed_at TIMESTAMPTZ
);

CREATE TABLE cloud_account_reauth_codes (
    account_id TEXT PRIMARY KEY REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    verification_id TEXT NOT NULL UNIQUE,
    code_mac BYTEA NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    resend_after TIMESTAMPTZ NOT NULL,
    window_started_at TIMESTAMPTZ NOT NULL,
    send_count INTEGER NOT NULL CHECK (send_count BETWEEN 1 AND 5),
    attempts_remaining INTEGER NOT NULL CHECK (attempts_remaining BETWEEN 0 AND 5),
    delivered_at TIMESTAMPTZ,
    consumed_at TIMESTAMPTZ
);

-- Email change refuses an address that a provider identity on another
-- account has verified.
CREATE INDEX IF NOT EXISTS idx_cloud_account_identities_verified_email
    ON cloud_account_identities (LOWER(email))
    WHERE email IS NOT NULL AND email_verified;
