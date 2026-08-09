-- Authorization-sensitive control replay must use immutable server order,
-- never the client-adjustable display timestamp.
ALTER TABLE cloud_messages
    ADD COLUMN IF NOT EXISTS server_received_at TIMESTAMPTZ;

UPDATE cloud_messages
SET server_received_at = COALESCE(
    NULLIF(delivered_at, '')::TIMESTAMPTZ,
    NULLIF(created_at, '')::TIMESTAMPTZ,
    clock_timestamp()
)
WHERE server_received_at IS NULL;

ALTER TABLE cloud_messages
    ALTER COLUMN server_received_at SET DEFAULT clock_timestamp(),
    ALTER COLUMN server_received_at SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_cloud_messages_session_server_received
    ON cloud_messages(session_id, server_received_at, message_id)
    WHERE session_id IS NOT NULL;
