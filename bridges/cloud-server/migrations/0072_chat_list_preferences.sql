ALTER TABLE cloud_chat_conversation_members
    ADD COLUMN IF NOT EXISTS pinned_at TIMESTAMPTZ;
