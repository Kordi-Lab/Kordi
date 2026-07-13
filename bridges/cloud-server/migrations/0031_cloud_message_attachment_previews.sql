-- Store client-generated compressed image previews alongside message attachment metadata.
-- The original attachment remains in object storage; preview_url is a small
-- data:image/* URL used for fast inline transcript rendering.

ALTER TABLE cloud_message_attachments
    ADD COLUMN IF NOT EXISTS preview_url TEXT;
