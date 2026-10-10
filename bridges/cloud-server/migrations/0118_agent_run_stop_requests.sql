-- The requester or owner of an agent run can ask its executor to stop it from
-- any device. Executors read the request with the lease renewal or heartbeat
-- they already send, stop the turn, and end the run as cancelled.
ALTER TABLE cloud_agent_fallback_runs
    ADD COLUMN IF NOT EXISTS cancel_requested_at TIMESTAMPTZ;
