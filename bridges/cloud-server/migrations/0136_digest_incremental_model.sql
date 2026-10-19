-- When the digest was last rebuilt from its whole input. Other runs only
-- apply the changes since the saved snapshot; a full rebuild runs once a day
-- or when the owner asks for one. Existing digests count from their last
-- update.
ALTER TABLE cloud_account_digests ADD COLUMN IF NOT EXISTS last_full_at TIMESTAMPTZ;
UPDATE cloud_account_digests SET last_full_at = updated_at
WHERE snapshot_json IS NOT NULL AND last_full_at IS NULL;
-- A new message that may need the owner's attention soon is waiting for a
-- quick check, and the time of the last check.
ALTER TABLE cloud_account_digests ADD COLUMN IF NOT EXISTS urgent_since TIMESTAMPTZ;
ALTER TABLE cloud_account_digests ADD COLUMN IF NOT EXISTS urgent_checked_at TIMESTAMPTZ;
-- The owner's digest model choice: {"model": "fast" | "chat" | model id,
-- "thinking": level}. NULL uses a fast model with low thinking.
ALTER TABLE cloud_account_digests ADD COLUMN IF NOT EXISTS model_preference JSONB;
-- The model and thinking level each digest run asked for.
ALTER TABLE cloud_digest_runs ADD COLUMN IF NOT EXISTS model TEXT;
ALTER TABLE cloud_digest_runs ADD COLUMN IF NOT EXISTS thinking TEXT;
