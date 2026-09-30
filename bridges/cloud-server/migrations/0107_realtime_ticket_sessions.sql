-- Bind each realtime ticket to the session that issued it so an open socket
-- stops when that session is signed out, not only when its device is revoked.
-- Tickets issued by older replicas during a rolling update keep a NULL session
-- and fall back to device revalidation until they expire (30 seconds).

ALTER TABLE cloud_chat_realtime_tickets
    ADD COLUMN IF NOT EXISTS session_token_id TEXT
        REFERENCES cloud_refresh_tokens(token_id) ON DELETE CASCADE;
