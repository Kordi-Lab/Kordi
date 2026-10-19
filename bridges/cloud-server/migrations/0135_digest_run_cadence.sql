-- When the owner last wrote in one of their chats. Background digest runs
-- wait until both the owner and their contacts have been quiet for a while.
ALTER TABLE cloud_account_digests ADD COLUMN IF NOT EXISTS owner_active_at TIMESTAMPTZ;
-- When opening the digest last started a run. Clients poll the digest while
-- it is open, so opening it starts at most one run per interval.
ALTER TABLE cloud_account_digests ADD COLUMN IF NOT EXISTS opened_run_at TIMESTAMPTZ;
-- Digest runs started per account, for the hourly and daily caps on
-- automatic runs. Rows older than two days are pruned as runs start.
CREATE TABLE IF NOT EXISTS cloud_digest_runs (
    run_id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    run_trigger TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cloud_digest_runs_account
    ON cloud_digest_runs (account_id, created_at);
