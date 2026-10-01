-- Deleted, hidden, and edited message content must not outlive the change in
-- replay rows or object storage. See docs/data-deletion.md.
--
-- This migration only adds indexes, columns, and tables. It never rewrites or
-- deletes existing rows; content changed before this version is left as it is.

CREATE INDEX IF NOT EXISTS idx_cloud_chat_sync_events_entity
    ON cloud_chat_user_sync_events(entity_id, account_id) WHERE entity_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cloud_chat_messages_deleted
    ON cloud_chat_messages(deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cloud_chat_message_visibility_hidden_at
    ON cloud_chat_message_visibility(deleted_at);
CREATE INDEX IF NOT EXISTS idx_cloud_chat_message_attachments_attachment
    ON cloud_chat_message_attachments(attachment_id);
CREATE INDEX IF NOT EXISTS idx_cloud_expressive_media_items_attachment
    ON cloud_expressive_media_items(attachment_id);
CREATE INDEX IF NOT EXISTS idx_cloud_session_artifacts_attachment
    ON cloud_session_artifacts(attachment_id) WHERE attachment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cloud_agent_fallback_runs_session_request
    ON cloud_agent_fallback_runs(session_id, request_message_id);

ALTER TABLE cloud_attachments
    ADD COLUMN IF NOT EXISTS purge_candidate_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS purge_requested_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS object_deleted_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_cloud_attachments_purge_candidates
    ON cloud_attachments(purge_candidate_at)
    WHERE purge_candidate_at IS NOT NULL AND purge_requested_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_cloud_attachments_purge_pending
    ON cloud_attachments(purge_requested_at)
    WHERE purge_requested_at IS NOT NULL AND object_deleted_at IS NULL;

-- Removal jobs hold identifiers only. There are no foreign keys on the
-- conversation or message so a job outlives the rows it describes.
CREATE TABLE IF NOT EXISTS cloud_content_removal_jobs (
    job_id              UUID PRIMARY KEY,
    reason              TEXT NOT NULL CHECK (reason IN ('message_deleted', 'message_edited',
                          'message_hidden', 'attachment_removed', 'attachment_released', 'backfill')),
    account_id          TEXT REFERENCES cloud_accounts(account_id) ON DELETE SET NULL,
    conversation_id     UUID,
    message_id          UUID,
    source_identifiers  TEXT[] NOT NULL DEFAULT '{}',
    attachment_ids      TEXT[] NOT NULL DEFAULT '{}',
    digests_done_at     TIMESTAMPTZ,
    records_done_at     TIMESTAMPTZ,
    attachments_done_at TIMESTAMPTZ,
    quotes_done_at      TIMESTAMPTZ,
    progress            JSONB NOT NULL DEFAULT '{}'::jsonb,
    attempts            INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    leased_until        TIMESTAMPTZ,
    last_error_code     TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at        TIMESTAMPTZ,
    CHECK (reason IN ('backfill', 'attachment_released')
           OR (conversation_id IS NOT NULL AND message_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_content_removal_jobs_deleted_message
    ON cloud_content_removal_jobs(message_id) WHERE reason = 'message_deleted';
CREATE INDEX IF NOT EXISTS idx_cloud_content_removal_jobs_deleted_conversation
    ON cloud_content_removal_jobs(conversation_id) WHERE reason = 'message_deleted';
CREATE INDEX IF NOT EXISTS idx_cloud_content_removal_jobs_due
    ON cloud_content_removal_jobs(next_attempt_at) WHERE completed_at IS NULL;

-- Automatic repair of deletions and hides written by an older server during
-- an upgrade reaches back no further than `automatic_since`, the time this
-- version was installed. `history_backfill_applied_at` records the first
-- operator backfill run with `--apply`; after it, repair may reach further.
CREATE TABLE IF NOT EXISTS cloud_content_removal_state (
    singleton                   BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    automatic_since             TIMESTAMPTZ NOT NULL DEFAULT now(),
    history_backfill_applied_at TIMESTAMPTZ
);
INSERT INTO cloud_content_removal_state (singleton) VALUES (TRUE)
    ON CONFLICT (singleton) DO NOTHING;
