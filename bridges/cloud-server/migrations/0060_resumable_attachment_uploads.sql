CREATE TABLE IF NOT EXISTS cloud_attachment_uploads (
    attachment_id    TEXT PRIMARY KEY
        REFERENCES cloud_attachments(attachment_id) ON DELETE CASCADE,
    upload_id        TEXT NOT NULL,
    chunk_size_bytes BIGINT NOT NULL CHECK (chunk_size_bytes > 0),
    total_size_bytes BIGINT NOT NULL CHECK (total_size_bytes >= 0),
    content_type     TEXT,
    status           TEXT NOT NULL DEFAULT 'uploading'
        CHECK (status IN ('uploading', 'completed', 'cancelled')),
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cloud_attachment_upload_parts (
    attachment_id TEXT NOT NULL
        REFERENCES cloud_attachment_uploads(attachment_id) ON DELETE CASCADE,
    part_number   INTEGER NOT NULL CHECK (part_number > 0),
    size_bytes    BIGINT NOT NULL CHECK (size_bytes >= 0),
    sha256_hex    TEXT NOT NULL,
    etag          TEXT NOT NULL,
    uploaded_at   TEXT NOT NULL,
    PRIMARY KEY (attachment_id, part_number)
);

CREATE INDEX IF NOT EXISTS idx_cloud_attachment_uploads_stale
    ON cloud_attachment_uploads(status, created_at);
