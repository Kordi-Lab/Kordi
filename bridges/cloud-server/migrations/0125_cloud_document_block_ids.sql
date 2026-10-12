-- Stable block ids (issue 1741). The document editor stamps blocks with ids
-- like `k:7f3a9c2d` so annotations follow a block wherever it moves.
-- Annotations accept those ids next to the index ids `b0`, `b1`, ...

ALTER TABLE cloud_document_reactions
    DROP CONSTRAINT IF EXISTS cloud_document_reactions_block_id_check;
ALTER TABLE cloud_document_reactions
    ADD CONSTRAINT cloud_document_reactions_block_id_check
    CHECK (block_id ~ '^(b[0-9]{1,5}|k:[A-Za-z0-9_-]{4,32})$');

ALTER TABLE cloud_document_comments
    DROP CONSTRAINT IF EXISTS cloud_document_comments_block_id_check;
ALTER TABLE cloud_document_comments
    ADD CONSTRAINT cloud_document_comments_block_id_check
    CHECK (block_id ~ '^(b[0-9]{1,5}|k:[A-Za-z0-9_-]{4,32})$');
