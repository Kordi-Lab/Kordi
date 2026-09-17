-- When a person's digest has unprocessed changes. dirty_since is the first
-- change since the digest last rebuilt, last_change_at the latest; the worker
-- reruns a marked digest after a quiet window, or after a maximum wait.
ALTER TABLE cloud_account_digests ADD COLUMN IF NOT EXISTS dirty_since TIMESTAMPTZ;
ALTER TABLE cloud_account_digests ADD COLUMN IF NOT EXISTS last_change_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_cloud_account_digests_dirty
    ON cloud_account_digests (last_change_at) WHERE dirty_since IS NOT NULL;
