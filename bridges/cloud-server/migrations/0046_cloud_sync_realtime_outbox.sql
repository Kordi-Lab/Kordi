-- Make the durable account-scoped sync log the source of realtime wakeups.
--
-- Existing rows predate the dispatcher and must not be replayed as a startup
-- storm. A constant historical timestamp lets PostgreSQL add the column
-- cheaply; dropping the default makes every future sync row pending.
ALTER TABLE cloud_sync_events
    ADD COLUMN IF NOT EXISTS realtime_published_at TIMESTAMPTZ
        DEFAULT TIMESTAMPTZ '1970-01-01 00:00:00+00',
    ADD COLUMN IF NOT EXISTS realtime_attempts INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS realtime_next_attempt_at TIMESTAMPTZ NOT NULL
        DEFAULT clock_timestamp(),
    ADD COLUMN IF NOT EXISTS realtime_claimed_until TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS realtime_claimed_by TEXT;

ALTER TABLE cloud_sync_events
    ALTER COLUMN realtime_published_at DROP DEFAULT;

CREATE INDEX IF NOT EXISTS idx_cloud_sync_events_realtime_pending
    ON cloud_sync_events (realtime_next_attempt_at, event_id)
    WHERE realtime_published_at IS NULL;
