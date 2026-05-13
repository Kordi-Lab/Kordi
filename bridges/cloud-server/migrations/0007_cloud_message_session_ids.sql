-- Preserve per-session identity for private self-agent Cloud history.
-- Direct human/agent peer conversations keep NULL; self-agent messages use the
-- local canonical session id so each agent session restores independently.
ALTER TABLE cloud_messages ADD COLUMN IF NOT EXISTS session_id TEXT;

CREATE INDEX IF NOT EXISTS idx_cloud_messages_self_session_created
    ON cloud_messages (from_account_id, to_account_id, session_id, created_at);
