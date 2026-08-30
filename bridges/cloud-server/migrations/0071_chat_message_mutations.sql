-- Account-scoped message deletion. Global deletion remains represented by
-- cloud_chat_messages.deleted_at so every participant converges on one tombstone.

CREATE TABLE IF NOT EXISTS cloud_chat_message_visibility (
    account_id TEXT NOT NULL
               REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    message_id UUID NOT NULL
               REFERENCES cloud_chat_messages(message_id) ON DELETE CASCADE,
    deleted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_cloud_chat_message_visibility_message
    ON cloud_chat_message_visibility(message_id);
