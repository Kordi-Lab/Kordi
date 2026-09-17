-- Consecutive failed digest generations, for backing off retries.
ALTER TABLE cloud_account_digests ADD COLUMN IF NOT EXISTS failure_count INTEGER NOT NULL DEFAULT 0;
