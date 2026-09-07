-- Freeze application-authored identity at admission; never rewrite past turns.
ALTER TABLE cloud_agent_fallback_runs ADD COLUMN turn_identity JSONB;
