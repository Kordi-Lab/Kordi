-- Cloud attachments — server-side metadata for objects stored in MinIO/S3.
-- The actual bytes live in the bucket; this row tracks ownership, the
-- object key the bytes ended up at, and post-upload metadata reported by
-- the client (size, sha256, content-type).
--
-- A row exists immediately after `attachments_initiate` returns a presigned
-- upload URL — `finalized_at IS NULL` means the client hasn't reported a
-- successful upload yet. A periodic GC can purge rows whose finalize
-- never landed within a TTL.

CREATE TABLE IF NOT EXISTS cloud_attachments (
    attachment_id    TEXT PRIMARY KEY,
    owner_account_id TEXT NOT NULL
        REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    object_key       TEXT NOT NULL UNIQUE,
    content_type     TEXT,
    size_bytes       BIGINT,
    sha256_hex       TEXT,
    created_at       TEXT NOT NULL,
    finalized_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_cloud_attachments_owner
    ON cloud_attachments(owner_account_id);
