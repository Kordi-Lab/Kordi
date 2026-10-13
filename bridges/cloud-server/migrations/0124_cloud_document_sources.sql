-- Forwarded document copies (issue 1741). Forwarding re-uploads an
-- attachment under the sender's account; the copy points at the document it
-- was forwarded from so reactions, comments, revisions, and links stay on one
-- canonical document. The canonical attachment is the end of the chain.

ALTER TABLE cloud_attachments
    ADD COLUMN IF NOT EXISTS document_source_attachment_id TEXT
        REFERENCES cloud_attachments(attachment_id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_cloud_attachments_document_source
    ON cloud_attachments(document_source_attachment_id)
    WHERE document_source_attachment_id IS NOT NULL;
