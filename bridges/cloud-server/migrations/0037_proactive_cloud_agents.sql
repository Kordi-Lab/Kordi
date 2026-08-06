DO $$
DECLARE
    mention_columns_existed BOOLEAN;
BEGIN
    SELECT
        EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = 'cloud_agent_definitions'
              AND column_name = 'mention_people_enabled'
        )
        AND EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = 'cloud_agent_definitions'
              AND column_name = 'mention_agents_enabled'
        )
    INTO mention_columns_existed;

    ALTER TABLE cloud_agent_definitions
        ADD COLUMN IF NOT EXISTS proactive_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS proactive_skill_pack TEXT NOT NULL DEFAULT 'proact-v1',
        ADD COLUMN IF NOT EXISTS mention_people_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        ADD COLUMN IF NOT EXISTS mention_agents_enabled BOOLEAN NOT NULL DEFAULT TRUE;

    -- Preserve the outbound mention behavior shipped before permissions existed,
    -- but never overwrite choices from an earlier proactive migration attempt.
    IF NOT mention_columns_existed THEN
        UPDATE cloud_agent_definitions
        SET mention_people_enabled = TRUE,
            mention_agents_enabled = TRUE;
    END IF;
END $$;

ALTER TABLE cloud_agent_definitions
    ALTER COLUMN proactive_skill_pack SET DEFAULT 'proact-v1',
    ALTER COLUMN proactive_skill_pack SET NOT NULL,
    ALTER COLUMN mention_people_enabled SET DEFAULT FALSE,
    ALTER COLUMN mention_agents_enabled SET DEFAULT FALSE;

ALTER TABLE cloud_agent_definitions
    DROP CONSTRAINT IF EXISTS cloud_agent_definitions_proactive_check;

ALTER TABLE cloud_agent_definitions
    ADD CONSTRAINT cloud_agent_definitions_proactive_check
        CHECK (
            proactive_skill_pack = 'proact-v1'
            AND (
                NOT proactive_enabled
                OR access_scope = 'participant_conversations'
            )
        );

ALTER TABLE cloud_agent_fallback_runs
    ADD COLUMN IF NOT EXISTS trigger_kind TEXT NOT NULL DEFAULT 'mention',
    ADD COLUMN IF NOT EXISTS target_agent_id TEXT,
    ADD COLUMN IF NOT EXISTS not_before_at TEXT,
    ADD COLUMN IF NOT EXISTS proactive_decision TEXT,
    ADD COLUMN IF NOT EXISTS proactive_breakdown TEXT,
    ADD COLUMN IF NOT EXISTS proactive_selected_skill TEXT,
    ADD COLUMN IF NOT EXISTS proactive_evidence_message_ids_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS proactive_skill_pack TEXT;

UPDATE cloud_agent_fallback_runs
SET trigger_kind = 'scheduled'
WHERE request_message_id LIKE 'scheduled_run_%'
   OR request_message_id LIKE 'scheduled_task:%';

ALTER TABLE cloud_agent_fallback_runs
    DROP CONSTRAINT IF EXISTS cloud_agent_fallback_runs_trigger_kind_check;

ALTER TABLE cloud_agent_fallback_runs
    ADD CONSTRAINT cloud_agent_fallback_runs_trigger_kind_check
        CHECK (trigger_kind IN ('mention', 'scheduled', 'proactive'));

ALTER TABLE cloud_agent_fallback_runs
    DROP CONSTRAINT IF EXISTS cloud_agent_fallback_runs_proactive_decision_check;

ALTER TABLE cloud_agent_fallback_runs
    ADD CONSTRAINT cloud_agent_fallback_runs_proactive_decision_check
        CHECK (proactive_decision IS NULL OR proactive_decision IN ('silence', 'intervention'));

CREATE INDEX IF NOT EXISTS idx_cloud_agent_fallback_runs_proactive_due
    ON cloud_agent_fallback_runs(status, not_before_at, target_agent_id)
    WHERE trigger_kind = 'proactive';

CREATE INDEX IF NOT EXISTS idx_cloud_agent_fallback_runs_proactive_owner
    ON cloud_agent_fallback_runs(owner_account_id, target_agent_id, created_at DESC)
    WHERE trigger_kind = 'proactive';
