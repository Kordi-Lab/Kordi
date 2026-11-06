-- Apple tokens still to revoke after their account was deleted.
SET LOCAL lock_timeout = '5s';

-- Deleting an account revokes its Apple tokens first. A token Apple could not
-- revoke then moves here in the deletion transaction, without the account,
-- and a worker retries it with backoff.
CREATE TABLE IF NOT EXISTS cloud_apple_token_revocations (
    token_id                 TEXT PRIMARY KEY,
    client_id                TEXT NOT NULL,
    refresh_token_ciphertext BYTEA NOT NULL,
    cipher_key_id            TEXT NOT NULL,
    attempts                 INTEGER NOT NULL DEFAULT 0,
    queued_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    next_attempt_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cloud_apple_token_revocations_due
    ON cloud_apple_token_revocations (next_attempt_at);
