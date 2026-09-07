-- Keep execution time separate from conversation edits, follow-ups and queue time.
ALTER TABLE cloud_agent_subsessions
    ADD COLUMN execution_started_at TIMESTAMPTZ,
    ADD COLUMN execution_finished_at TIMESTAMPTZ;

-- Older initial executions retain their recorded message timestamps. Do not
-- invent a start time for historical follow-ups whose admission was not saved.
UPDATE cloud_agent_subsessions s
SET execution_started_at = (
        SELECT to_timestamp(min((m->>'timestampMs')::double precision) / 1000)
        FROM jsonb_array_elements(s.messages) m
        WHERE m->>'role'='user' AND (m->>'timestampMs')::bigint > 0
    ),
    execution_finished_at = CASE WHEN s.status <> 'running' THEN (
        SELECT to_timestamp(max((m->>'timestampMs')::double precision) / 1000)
        FROM jsonb_array_elements(s.messages) m
        WHERE m->>'role'='assistant' AND (m->>'timestampMs')::bigint > 0
    ) END
WHERE s.status <> 'running'
  AND NOT EXISTS (SELECT 1 FROM cloud_agent_subsession_chat c WHERE c.subsession_id=s.subsession_id AND c.run_id IS NOT NULL);
