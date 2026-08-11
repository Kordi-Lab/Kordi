-- Move Cloud-agent artifacts onto canonical v2 message identities. Retained
-- v1 rows remain available for audit/backfill, but new artifact writes no
-- longer require a cloud_messages row.

ALTER TABLE cloud_agent_run_artifacts
    DROP CONSTRAINT IF EXISTS cloud_agent_run_artifacts_message_id_fkey;

ALTER TABLE cloud_agent_run_artifacts
    ADD COLUMN IF NOT EXISTS canonical_message_id UUID
        REFERENCES cloud_chat_messages(message_id) ON DELETE CASCADE;

UPDATE cloud_agent_run_artifacts artifact
SET canonical_message_id = mapping.canonical_message_id
FROM cloud_chat_legacy_message_map mapping
WHERE artifact.canonical_message_id IS NULL
  AND mapping.legacy_message_id = artifact.message_id;

CREATE INDEX IF NOT EXISTS idx_cloud_agent_run_artifacts_canonical_message
    ON cloud_agent_run_artifacts(canonical_message_id)
    WHERE canonical_message_id IS NOT NULL;

ALTER TABLE cloud_attachments
    ADD COLUMN IF NOT EXISTS preview_url TEXT;
