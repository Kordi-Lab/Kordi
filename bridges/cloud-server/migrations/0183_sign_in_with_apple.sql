-- Sign in with Apple (App Store Review guideline 4.8).
SET LOCAL lock_timeout = '5s';

-- Apple posts the browser sign-in code back (response_mode=form_post). The
-- POST callback keeps it with its state until the GET callback, which runs in
-- the browser's own context, consumes both.
ALTER TABLE cloud_oauth_states
    ADD COLUMN IF NOT EXISTS form_post_code TEXT,
    ADD COLUMN IF NOT EXISTS form_post_user TEXT;

-- Apple refresh tokens, sealed with the provider-auth cipher, so they can be
-- revoked when the account is deleted or Apple is unlinked.
CREATE TABLE IF NOT EXISTS cloud_apple_tokens (
    token_id                 TEXT PRIMARY KEY,
    account_id               TEXT NOT NULL
        REFERENCES cloud_accounts (account_id) ON DELETE CASCADE,
    provider_subject         TEXT NOT NULL,
    client_id                TEXT NOT NULL,
    refresh_token_ciphertext BYTEA NOT NULL,
    cipher_key_id            TEXT NOT NULL,
    created_at               TEXT NOT NULL,
    updated_at               TEXT NOT NULL,
    UNIQUE (provider_subject, client_id)
);

CREATE INDEX IF NOT EXISTS idx_cloud_apple_tokens_account
    ON cloud_apple_tokens (account_id);
