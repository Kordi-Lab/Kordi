-- Device review recovery (pending installations could lock an account out of
-- device management). `review_started_at` marks when an installation entered
-- `pending_review`; the server confirms it automatically once the review window
-- passes or when no confirmed installation remains to approve it.
-- `machine_hash` is an account-salted hash of the client's machine identifier.
-- It only marks installations that share the caller's machine and is never
-- returned to clients.

ALTER TABLE cloud_devices
    ADD COLUMN IF NOT EXISTS review_started_at TEXT,
    ADD COLUMN IF NOT EXISTS machine_hash TEXT;

UPDATE cloud_devices
SET review_started_at = created_at
WHERE authorization_state = 'pending_review' AND review_started_at IS NULL;
