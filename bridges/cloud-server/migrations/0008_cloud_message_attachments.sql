-- Attach finalized cloud attachment metadata to specific cloud message rows.
-- Access is derived from message visibility: the sender and recipient of a
-- linked cloud_messages row can request a presigned download URL.

CREATE TABLE IF NOT EXISTS cloud_message_attachments (
    message_id    TEXT NOT NULL
        REFERENCES cloud_messages(message_id) ON DELETE CASCADE,
    attachment_id TEXT NOT NULL
        REFERENCES cloud_attachments(attachment_id) ON DELETE RESTRICT,
    name          TEXT NOT NULL,
    kind          TEXT NOT NULL CHECK (kind IN ('image', 'file')),
    mime_type     TEXT,
    size_bytes    BIGINT,
    position      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (message_id, attachment_id)
);

CREATE INDEX IF NOT EXISTS idx_cloud_message_attachments_attachment
    ON cloud_message_attachments(attachment_id);
