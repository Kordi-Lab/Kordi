-- Email codes that let a signed-in account prove it can read its primary
-- email, so accounts created before signup verification can later link
-- provider identities by email. Rules match cloud_signup_email_codes.
CREATE TABLE cloud_account_email_codes (
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
