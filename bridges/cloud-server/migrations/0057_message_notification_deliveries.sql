ALTER TABLE cloud_message_notification_events
    DROP COLUMN attempt_count,
    DROP COLUMN last_attempt_at;

CREATE TABLE cloud_message_notification_deliveries (
    recipient_account_id TEXT NOT NULL,
    message_id UUID NOT NULL,
    device_id TEXT NOT NULL
        REFERENCES cloud_devices(device_id) ON DELETE CASCADE,
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    last_attempt_at TIMESTAMPTZ,
    accepted_at TIMESTAMPTZ,
    failed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (recipient_account_id, message_id, device_id),
    FOREIGN KEY (recipient_account_id, message_id)
        REFERENCES cloud_message_notification_events(recipient_account_id, message_id)
        ON DELETE CASCADE,
    CHECK (accepted_at IS NULL OR failed_at IS NULL)
);

CREATE INDEX cloud_message_notification_deliveries_pending
    ON cloud_message_notification_deliveries(last_attempt_at, created_at)
    WHERE accepted_at IS NULL AND failed_at IS NULL;

INSERT INTO cloud_message_notification_deliveries
    (recipient_account_id, message_id, device_id)
SELECT event.recipient_account_id, event.message_id, push.device_id
FROM cloud_message_notification_events event
JOIN cloud_apns_push_tokens push
    ON push.account_id = event.recipient_account_id
   AND push.message_notifications_enabled
JOIN cloud_devices device
    ON device.device_id = push.device_id
   AND device.account_id = push.account_id
   AND device.revoked_at IS NULL
WHERE event.accepted_at IS NULL
  AND EXISTS (
      SELECT 1
      FROM cloud_refresh_tokens session
      WHERE session.device_id = device.device_id
        AND session.account_id = push.account_id
        AND session.revoked_at IS NULL
        AND session.expires_at::timestamptz > NOW()
  )
ON CONFLICT (recipient_account_id, message_id, device_id) DO NOTHING;

UPDATE cloud_message_notification_events event
SET accepted_at = NOW()
WHERE event.accepted_at IS NULL
  AND NOT EXISTS (
      SELECT 1
      FROM cloud_message_notification_deliveries delivery
      WHERE delivery.recipient_account_id = event.recipient_account_id
        AND delivery.message_id = event.message_id
        AND delivery.accepted_at IS NULL
        AND delivery.failed_at IS NULL
  );
