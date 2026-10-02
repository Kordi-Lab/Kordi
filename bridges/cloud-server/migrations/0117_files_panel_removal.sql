-- A files-panel entry archived because its source message was deleted for
-- everyone, or because its file was deleted, stays archived: `removed_at`
-- marks it, and a client that publishes the same entry again neither changes
-- nor lists it. See docs/data-deletion.md.
--
-- This migration only adds a nullable column. It changes no existing row.
ALTER TABLE cloud_session_artifacts ADD COLUMN IF NOT EXISTS removed_at TIMESTAMPTZ;
