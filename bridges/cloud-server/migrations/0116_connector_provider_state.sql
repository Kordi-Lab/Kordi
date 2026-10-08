-- Connector providers (issue 1712, PR 3): per-connector settings such as the
-- Slack channels a person chose, the provider account used to route
-- webhooks, event timestamps, and one-time event storage.

ALTER TABLE cloud_connectors
    ADD COLUMN settings JSONB NOT NULL DEFAULT '{}'
        CHECK (jsonb_typeof(settings) = 'object'),
    ADD COLUMN provider_account_id TEXT,
    ADD COLUMN last_event_at TIMESTAMPTZ,
    ADD COLUMN last_polled_at TIMESTAMPTZ,
    ADD COLUMN subscribed_at TIMESTAMPTZ;

-- Webhooks and push find live connectors by provider account.
CREATE INDEX idx_cloud_connectors_provider_account_live
    ON cloud_connectors (provider, provider_account_id)
    WHERE status <> 'revoked' AND provider_account_id IS NOT NULL;

-- The polling job claims connected connectors in order of their last poll.
CREATE INDEX idx_cloud_connectors_poll_due
    ON cloud_connectors (last_polled_at NULLS FIRST)
    WHERE status = 'connected';

-- Webhook retries, replays, and overlapping polls record an event once.
DELETE FROM cloud_connector_events e
USING cloud_connector_events keep
WHERE e.connector_id = keep.connector_id
  AND e.external_id = keep.external_id
  AND e.event_id > keep.event_id;

CREATE UNIQUE INDEX idx_cloud_connector_events_connector_external
    ON cloud_connector_events (connector_id, external_id)
    WHERE external_id IS NOT NULL;

-- The callback learns the provider account before the grant is completed.
ALTER TABLE cloud_connector_pending_grants
    ADD COLUMN provider_account_id TEXT;
