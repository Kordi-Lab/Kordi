-- Editable shared documents (issue 1741). The first read of a Markdown
-- document copies the attachment bytes here at revision 1; from then on this
-- source is canonical for every route. A save replaces the whole source and
-- increments the revision. Timestamps are RFC 3339 text like the other
-- document tables.

CREATE TABLE IF NOT EXISTS cloud_document_contents (
    attachment_id         TEXT PRIMARY KEY
                          REFERENCES cloud_attachments(attachment_id) ON DELETE CASCADE,
    source                TEXT NOT NULL,
    revision              BIGINT NOT NULL DEFAULT 1 CHECK (revision >= 1),
    updated_by_account_id TEXT
                          REFERENCES cloud_accounts(account_id) ON DELETE SET NULL,
    updated_at            TEXT NOT NULL
);
