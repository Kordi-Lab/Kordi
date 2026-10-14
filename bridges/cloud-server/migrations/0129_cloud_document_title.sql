-- Renamed document titles (issue 1741). A member who may edit a Markdown
-- document may rename it; the title is stored on the canonical attachment
-- and shown where the document has no leading level-1 heading. The file
-- name is unchanged. NULL means the title comes from the document or the
-- file name.

ALTER TABLE cloud_attachments
    ADD COLUMN IF NOT EXISTS document_title TEXT;
