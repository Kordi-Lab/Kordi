-- Comment runs route like chat runs (issue 1741). When the agent owner's Mac
-- is ready, a comment run waits for that Mac to claim it: the cloud runner
-- does not lease the run until `desktop_preferred_until` has passed. The
-- desktop claim clears the column. NULL means the cloud may lease at once.

ALTER TABLE cloud_agent_fallback_runs
    ADD COLUMN IF NOT EXISTS desktop_preferred_until TIMESTAMPTZ;
