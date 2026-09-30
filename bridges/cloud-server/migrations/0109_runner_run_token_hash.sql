-- Hash of the run-scoped credential issued with the current cloud runner
-- lease. Each lease replaces it, so a credential from an earlier lease stops
-- working. The plaintext credential is never stored.
ALTER TABLE cloud_agent_fallback_runs
    ADD COLUMN IF NOT EXISTS runner_run_token_hash TEXT NULL;
