-- AI consent (docs/development/ai-consent.md).
--
-- Every account starts `unset`; its owner may allow or decline sharing
-- content with AI models. Background AI work skips accounts that have not
-- allowed it, and nothing sends a declined account's content to a model.
-- Adding a column with a constant default does not rewrite the table.
SET LOCAL lock_timeout = '5s';

ALTER TABLE cloud_accounts
    ADD COLUMN IF NOT EXISTS ai_consent_status TEXT NOT NULL DEFAULT 'unset'
        CONSTRAINT cloud_accounts_ai_consent_status_check
        CHECK (ai_consent_status IN ('unset', 'allowed', 'declined'));
ALTER TABLE cloud_accounts
    ADD COLUMN IF NOT EXISTS ai_consent_decided_at TIMESTAMPTZ;

-- Background sweeps and leases look up the few declined accounts.
CREATE INDEX IF NOT EXISTS idx_cloud_accounts_ai_consent_declined
    ON cloud_accounts (account_id) WHERE ai_consent_status = 'declined';
