-- Stable per-recipient client ids make Cloud message retries idempotent.
ALTER TABLE cloud_messages
    ADD COLUMN IF NOT EXISTS client_message_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_messages_sender_recipient_client_id
    ON cloud_messages(from_account_id, to_account_id, client_message_id)
    WHERE client_message_id IS NOT NULL;
