-- Complete the chat-sync v2 cutover. Canonicalize every retained reference
-- that can still point at a v1 message before removing the compatibility
-- tables. The assertions deliberately fail the migration instead of allowing
-- a partial or lossy retirement.

UPDATE cloud_agent_fallback_runs run
SET request_message_id = mapping.canonical_message_id::text
FROM cloud_chat_legacy_message_map mapping
WHERE run.request_message_id = mapping.legacy_message_id;

-- Unmatched request_message_id values are durable inner-envelope or scheduled
-- run identities. They never referenced cloud_messages and intentionally stay
-- stable so idempotent agent-run lookup continues to work.

UPDATE cloud_agent_fallback_runs run
SET response_message_id = mapping.canonical_message_id::text
FROM cloud_chat_legacy_message_map mapping
WHERE run.response_message_id = mapping.legacy_message_id;

UPDATE cloud_session_forks fork
SET parent_message_id = mapping.canonical_message_id::text
FROM cloud_chat_legacy_message_map mapping
WHERE fork.parent_message_id = mapping.legacy_message_id;

UPDATE cloud_session_tasks task
SET response_message_id = mapping.canonical_message_id::text
FROM cloud_chat_legacy_message_map mapping
WHERE task.response_message_id = mapping.legacy_message_id;

UPDATE cloud_session_artifacts artifact
SET source_message_id = mapping.canonical_message_id::text
FROM cloud_chat_legacy_message_map mapping
WHERE artifact.source_message_id = mapping.legacy_message_id;

UPDATE cloud_session_shared_pins pin
SET message_id = mapping.canonical_message_id::text
FROM cloud_chat_legacy_message_map mapping
WHERE pin.message_id = mapping.legacy_message_id;

UPDATE cloud_account_session_pins pin
SET message_id = mapping.canonical_message_id::text
FROM cloud_chat_legacy_message_map mapping
WHERE pin.message_id = mapping.legacy_message_id;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM cloud_agent_fallback_runs run
        LEFT JOIN cloud_chat_messages message
          ON message.message_id::text = run.response_message_id
        WHERE run.response_message_id IS NOT NULL
          AND message.message_id IS NULL
    ) THEN
        RAISE EXCEPTION 'cannot retire chat sync v1: an agent response has no canonical v2 message';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM cloud_agent_run_artifacts artifact
        LEFT JOIN cloud_chat_messages message
          ON message.message_id = artifact.canonical_message_id
        WHERE artifact.canonical_message_id IS NULL
           OR message.message_id IS NULL
    ) THEN
        RAISE EXCEPTION 'cannot retire chat sync v1: an agent artifact has no canonical v2 message';
    END IF;
END $$;

-- Remove the transitional text identity from agent artifacts. From this
-- migration onward the single message_id column is a canonical v2 UUID.
DROP INDEX IF EXISTS idx_cloud_agent_run_artifacts_canonical_message;

ALTER TABLE cloud_agent_run_artifacts
    DROP COLUMN message_id;

ALTER TABLE cloud_agent_run_artifacts
    RENAME COLUMN canonical_message_id TO message_id;

ALTER TABLE cloud_agent_run_artifacts
    ALTER COLUMN message_id SET NOT NULL;

ALTER TABLE cloud_agent_run_artifacts
    RENAME CONSTRAINT cloud_agent_run_artifacts_canonical_message_id_fkey
    TO cloud_agent_run_artifacts_message_id_fkey;

CREATE INDEX idx_cloud_agent_run_artifacts_message
    ON cloud_agent_run_artifacts(message_id);

-- Every supported chat client speaks protocol v2. Authentication, contacts,
-- attachments, agent operations, and presence retain their existing /v1 API
-- paths; this constraint applies only to the chat-sync protocol negotiated by
-- a device.
UPDATE cloud_devices
SET protocol_version = 2
WHERE protocol_version <> 2;

ALTER TABLE cloud_devices
    ALTER COLUMN protocol_version SET DEFAULT 2;

ALTER TABLE cloud_devices
    ADD CONSTRAINT cloud_devices_chat_protocol_v2_only
    CHECK (protocol_version = 2);

-- Drop compatibility state in dependency order. No CASCADE is used: a newly
-- introduced dependency must make this migration fail and receive an explicit
-- V2 migration instead of being deleted implicitly.
DROP TABLE IF EXISTS cloud_chat_legacy_message_map;
DROP TABLE IF EXISTS cloud_message_attachments;
DROP TABLE IF EXISTS cloud_messages;
DROP TABLE IF EXISTS cloud_sync_events;
DROP TABLE IF EXISTS cloud_read_cursors;
DROP TABLE IF EXISTS cloud_session_titles;

-- The original node-mailbox prototype was never wired to a public route and
-- contains no production rows. Canonical chat v2 replaces it as well.
DROP TABLE IF EXISTS server_message_recipients;
DROP TABLE IF EXISTS server_messages;
