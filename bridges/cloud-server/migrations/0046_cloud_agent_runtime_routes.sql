-- Preserve the model/thinking route selected for a specific chat session so
-- hosted execution uses the same route as the requesting Mac or iPhone.
ALTER TABLE cloud_agent_fallback_runs
    ADD COLUMN IF NOT EXISTS runtime_route_json JSONB NOT NULL DEFAULT '{}'::jsonb;
