-- Upgrade databases that already applied the original 80/81 migrations.
-- No conversation ID, request ID, result, or execution event is rewritten.
ALTER TABLE cloud_chat_conversations DROP CONSTRAINT IF EXISTS cloud_chat_direct_session_identity;
CREATE OR REPLACE FUNCTION enforce_direct_session_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.kind IS NOT DISTINCT FROM OLD.kind
       AND NEW.legacy_session_id IS NOT DISTINCT FROM OLD.legacy_session_id THEN
        RETURN NEW;
    END IF;
    IF NEW.kind = 'direct' AND NOT COALESCE(
        NEW.legacy_session_id LIKE 'session:direct-person:%'
        OR NEW.legacy_session_id LIKE 'session:direct-agent:%'
        OR NEW.legacy_session_id LIKE 'session:direct-system-agent:%', FALSE) THEN
        RAISE EXCEPTION 'direct conversation session id is invalid'
            USING ERRCODE = '23514', CONSTRAINT = 'cloud_chat_direct_session_identity';
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS cloud_chat_direct_session_identity ON cloud_chat_conversations;
CREATE TRIGGER cloud_chat_direct_session_identity
    BEFORE INSERT OR UPDATE OF kind, legacy_session_id ON cloud_chat_conversations
    FOR EACH ROW EXECUTE FUNCTION enforce_direct_session_identity();

ALTER TABLE cloud_agent_fallback_runs ADD COLUMN IF NOT EXISTS legacy_duplicate BOOLEAN NOT NULL DEFAULT FALSE;
WITH ranked AS (
    SELECT run_id, row_number() OVER (
        PARTITION BY owner_account_id, execution_agent_id, request_message_id
        ORDER BY (status IN ('queued','leased','running')) DESC,
                 (status = 'completed') DESC, created_at DESC, run_id DESC
    ) AS ordinal FROM cloud_agent_fallback_runs
)
UPDATE cloud_agent_fallback_runs run SET legacy_duplicate = ranked.ordinal > 1
FROM ranked WHERE ranked.run_id = run.run_id
    AND run.legacy_duplicate IS DISTINCT FROM (ranked.ordinal > 1);
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='cloud_agent_fallback_runs'::regclass
                   AND conname='cloud_agent_legacy_duplicate_terminal') THEN
        ALTER TABLE cloud_agent_fallback_runs ADD CONSTRAINT cloud_agent_legacy_duplicate_terminal
            CHECK (NOT legacy_duplicate OR status IN ('completed','failed','cancelled'));
    END IF;
END $$;
-- Keep an existing full index for compatibility with an older API during a
-- rolling upgrade. New claims can infer either index using the predicate.
CREATE UNIQUE INDEX IF NOT EXISTS cloud_agent_request_executor_current
    ON cloud_agent_fallback_runs(owner_account_id, execution_agent_id, request_message_id)
    WHERE NOT legacy_duplicate;
