-- Pip, the built-in plan agent, keeps one sweep row per conversation it is a
-- member of. The row records how far Pip has read, which run (if any) is in
-- flight, a bounded retry schedule, and which one-shot hooks already fired so
-- a nudge is never repeated for the same card revision.
CREATE TABLE IF NOT EXISTS cloud_pip_conversation_state (
    conversation_id   UUID PRIMARY KEY
        REFERENCES cloud_chat_conversations (conversation_id) ON DELETE CASCADE,
    seen_sequence     BIGINT NOT NULL DEFAULT 0,
    active_run_id     TEXT,
    attempts          INTEGER NOT NULL DEFAULT 0,
    retry_after       TIMESTAMPTZ NOT NULL DEFAULT now(),
    checked_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    hooks_fired       JSONB NOT NULL DEFAULT '{}'::jsonb,
    last_error        TEXT,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cloud_pip_conversation_state_due
    ON cloud_pip_conversation_state (retry_after, checked_at)
    WHERE active_run_id IS NULL;
