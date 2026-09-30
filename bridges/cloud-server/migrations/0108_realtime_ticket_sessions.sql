-- Bind each realtime ticket to the session that issued it so an open socket
-- stops when that session is signed out, not only when its device is revoked.
--
-- During a rolling update, older replicas still issue tickets with a NULL
-- session. Sockets opened with such a ticket keep the device check and are
-- closed after a bounded lifetime so clients reconnect with a session-bound
-- ticket. Sockets that older replicas accept keep their older behavior until
-- those replicas stop at the end of the rollout.

ALTER TABLE cloud_chat_realtime_tickets
    ADD COLUMN IF NOT EXISTS session_token_id TEXT
        REFERENCES cloud_refresh_tokens(token_id) ON DELETE CASCADE;
