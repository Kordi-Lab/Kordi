-- Durable account-scoped Cloud sync event log.
--
-- Clients keep the last applied event_id as a cursor and ask for events after
-- that cursor. Rows are scoped to the account that must observe the change, so
-- authorization is a simple account_id filter.
CREATE TABLE IF NOT EXISTS cloud_sync_events (
    event_id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    account_id      TEXT NOT NULL
        REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    event_type      TEXT NOT NULL,
    peer_account_id TEXT,
    message_id      TEXT,
    payload_json    JSONB NOT NULL,
    occurred_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cloud_sync_events_account_event
    ON cloud_sync_events (account_id, event_id);
