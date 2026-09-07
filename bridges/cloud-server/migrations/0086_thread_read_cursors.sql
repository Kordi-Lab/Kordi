CREATE TABLE cloud_chat_thread_read_cursors (
    conversation_id UUID NOT NULL REFERENCES cloud_chat_conversations(conversation_id) ON DELETE CASCADE,
    root_message_id UUID NOT NULL REFERENCES cloud_chat_messages(message_id) ON DELETE CASCADE,
    account_id TEXT NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    last_read_sequence BIGINT NOT NULL CHECK (last_read_sequence >= 0),
    PRIMARY KEY (conversation_id, account_id, root_message_id)
);
