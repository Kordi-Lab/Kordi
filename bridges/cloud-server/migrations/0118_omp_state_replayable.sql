-- Whether a saved runtime state may be replayed, stored beside the state so
-- that choosing which state to replay never reads a state document. A state
-- saved by a server without this column is not replayed.
ALTER TABLE cloud_agent_omp_state
    ADD COLUMN IF NOT EXISTS replayable BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE cloud_agent_omp_state SET replayable = TRUE
 WHERE NOT replayable AND state_json->'replayable' = 'true'::jsonb;
