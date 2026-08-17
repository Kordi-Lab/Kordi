-- Account-owned sticker and GIF library entries. Media bytes continue to use
-- the authenticated attachment store; this table provides the durable,
-- cross-device account index.

CREATE TABLE IF NOT EXISTS cloud_expressive_media_items (
    item_id       TEXT PRIMARY KEY,
    account_id    TEXT NOT NULL
        REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    attachment_id TEXT NOT NULL
        REFERENCES cloud_attachments(attachment_id) ON DELETE CASCADE,
    kind          TEXT NOT NULL CHECK (kind IN ('sticker', 'gif')),
    name          TEXT NOT NULL,
    mime_type     TEXT NOT NULL,
    size_bytes    BIGINT NOT NULL CHECK (size_bytes >= 0),
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    UNIQUE (account_id, attachment_id)
);

CREATE INDEX IF NOT EXISTS idx_cloud_expressive_media_account_created
    ON cloud_expressive_media_items (account_id, created_at DESC);
