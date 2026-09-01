ALTER TABLE cloud_chat_conversation_members
    ADD COLUMN IF NOT EXISTS marked_unread_at TIMESTAMPTZ;
