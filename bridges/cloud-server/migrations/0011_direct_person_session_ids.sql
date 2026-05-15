-- Make Cloud direct-person conversations first-class session-scoped history.
-- Older direct messages were synced by account pair with NULL session_id; backfill
-- the stable sorted Cloud session id so forks/read models can address the exact
-- conversation trajectory authoritatively from Cloud.
UPDATE cloud_messages
SET session_id = 'session:direct-person:' || LEAST(from_account_id, to_account_id) || ':' || GREATEST(from_account_id, to_account_id)
WHERE session_id IS NULL
  AND from_account_id <> to_account_id
  AND body NOT LIKE 'kordi-cloud-group:%';

CREATE INDEX IF NOT EXISTS idx_cloud_messages_session_created
    ON cloud_messages (session_id, created_at);
