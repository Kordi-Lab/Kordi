-- Capture is already active from migration 92, so backfill does not need a
-- global sync-write lock and cannot miss actions from older server replicas.
-- Recover actual actions still present in the retained sync journal. Shared
-- fanout copies represent one action, not one history entry per recipient.
-- Do not invent events from current pin state or assign old actions a new time.
WITH actions AS (
    SELECT DISTINCT conversation_id, payload->>'sessionId' AS session_id,
           payload->>'scope' AS scope, payload->>'updatedByAccountId' AS actor,
           payload->>'pinHistoryId' AS source_id,
           payload->>'updatedAt' AS occurred_at, NULLIF(payload->>'messageId', '') AS message_id
    FROM cloud_chat_user_sync_events
    WHERE event_type = 'session.pin.updated' AND conversation_id IS NOT NULL
      AND NOT (payload ? 'pinHistoryEvent')
      AND payload->>'scope' IN ('private', 'shared')
      AND COALESCE(payload->>'sessionId', '') <> ''
      AND COALESCE(payload->>'updatedAt', '') <> ''
), identified AS (
    SELECT actions.*, session_pin_history_time(occurred_at) AS action_time, CASE WHEN COALESCE(source_id, '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN source_id::uuid ELSE md5(jsonb_build_array(conversation_id, session_id, scope, actor, occurred_at, message_id)::text)::uuid END AS id
    FROM actions JOIN cloud_accounts ON cloud_accounts.account_id = actions.actor
    WHERE session_pin_history_time(occurred_at) IS NOT NULL
)
INSERT INTO cloud_session_pin_history(event_id, occurred_at, conversation_id, actor_account_id, scope, payload)
SELECT id, action_time, conversation_id, actor, scope,
       jsonb_build_object('id', id::text, 'sessionId', session_id,
          'kind', CASE WHEN message_id IS NULL THEN 'unpinned' ELSE 'pinned' END,
          'scope', scope, 'messageId', message_id, 'updatedByAccountId', actor, 'updatedAt', occurred_at)
FROM identified ORDER BY occurred_at, id
ON CONFLICT (event_id) DO NOTHING;

UPDATE cloud_session_pin_history SET payload = payload || jsonb_build_object('sequence', sequence)
WHERE NOT (payload ? 'sequence');
