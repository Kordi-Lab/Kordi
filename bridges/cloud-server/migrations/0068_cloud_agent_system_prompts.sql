ALTER TABLE cloud_agent_fallback_runs
    ADD COLUMN IF NOT EXISTS system_prompt TEXT NOT NULL DEFAULT '';
