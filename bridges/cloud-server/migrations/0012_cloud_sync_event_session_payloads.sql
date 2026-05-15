-- Keep historical diff-sync payloads consistent with the canonical
-- cloud_messages.session_id backfill. Clients that replay from cursor 0 should
-- see the same session-scoped trajectory as list_messages.
UPDATE cloud_sync_events AS event
SET payload_json = jsonb_set(
    event.payload_json,
    '{message,sessionId}',
    to_jsonb(message.session_id)
)
FROM cloud_messages AS message
WHERE event.message_id = message.message_id
  AND event.event_type = 'message.upsert'
  AND message.session_id IS NOT NULL
  AND COALESCE(event.payload_json->'message'->>'sessionId', '') = '';
