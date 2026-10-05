-- Email ownership is proven before password accounts and sessions are created.
ALTER TABLE cloud_accounts
    ADD COLUMN IF NOT EXISTS primary_email_verified_at TEXT;

CREATE TABLE cloud_signup_email_codes (
    email TEXT PRIMARY KEY,
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
