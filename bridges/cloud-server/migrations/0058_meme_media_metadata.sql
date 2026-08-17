-- Record the server-observed raster format for attachment bytes. Meme sends
-- require this value so a client-provided MIME type cannot turn arbitrary
-- content into an image attachment.

ALTER TABLE cloud_attachments
    ADD COLUMN IF NOT EXISTS detected_content_type TEXT;
