-- Legacy Kordi Support messages were self-addressed, so the Chat v2 backfill
-- could classify their stable system-agent session as a private AI chat. Keep
-- that transcript private under a quarantined identity and free the stable
-- Support session id for the real direct conversation.
CREATE TEMP TABLE _legacy_support_conversations ON COMMIT DROP AS
SELECT conversation.conversation_id,
       conversation.created_by_account_id AS account_id,
       conversation.legacy_session_id AS support_session_id,
       'session:quarantined-support:' || conversation.conversation_id::text AS quarantine_session_id
FROM cloud_chat_conversations conversation
WHERE conversation.kind = 'ai'
  AND conversation.legacy_session_id =
      'session:direct-system-agent:'
      || conversation.created_by_account_id
      || ':cloud_agent_kordi_support'
  AND (
      SELECT count(*)
      FROM cloud_chat_conversation_members member
      WHERE member.conversation_id = conversation.conversation_id
        AND member.membership_state = 'active'
  ) = 1
  AND EXISTS (
      SELECT 1
      FROM cloud_chat_conversation_members member
      WHERE member.conversation_id = conversation.conversation_id
        AND member.account_id = conversation.created_by_account_id
        AND member.membership_state = 'active'
  );

UPDATE cloud_session_forks fork
SET fork_session_id = legacy.quarantine_session_id
FROM _legacy_support_conversations legacy
WHERE fork.fork_session_id = legacy.support_session_id;

UPDATE cloud_session_forks fork
SET parent_session_id = legacy.quarantine_session_id
FROM _legacy_support_conversations legacy
WHERE fork.parent_session_id = legacy.support_session_id;

UPDATE cloud_session_tasks task
SET session_id = legacy.quarantine_session_id
FROM _legacy_support_conversations legacy
WHERE task.session_id = legacy.support_session_id;

UPDATE cloud_session_artifacts artifact
SET session_id = legacy.quarantine_session_id
FROM _legacy_support_conversations legacy
WHERE artifact.session_id = legacy.support_session_id;

UPDATE cloud_session_shared_pins pin
SET session_id = legacy.quarantine_session_id
FROM _legacy_support_conversations legacy
WHERE pin.session_id = legacy.support_session_id;

UPDATE cloud_account_session_pins pin
SET session_id = legacy.quarantine_session_id
FROM _legacy_support_conversations legacy
WHERE pin.session_id = legacy.support_session_id;

UPDATE cloud_account_session_visibility visibility
SET session_id = legacy.quarantine_session_id
FROM _legacy_support_conversations legacy
WHERE visibility.session_id = legacy.support_session_id;

UPDATE cloud_agent_fallback_runs run
SET session_id = legacy.quarantine_session_id
FROM _legacy_support_conversations legacy
WHERE run.session_id = legacy.support_session_id;

UPDATE cloud_agent_sandboxes sandbox
SET session_id = legacy.quarantine_session_id
FROM _legacy_support_conversations legacy
WHERE sandbox.session_id = legacy.support_session_id;

UPDATE scheduled_tool_tasks task
SET tool_payload_json = jsonb_set(
    task.tool_payload_json,
    '{sessionId}',
    to_jsonb(legacy.quarantine_session_id),
    false
)
FROM _legacy_support_conversations legacy
WHERE task.owner_account_id = legacy.account_id
  AND task.tool_payload_json ->> 'sessionId' = legacy.support_session_id;

-- Fresh bootstrap and retained event replay must agree on the quarantined
-- identity. A new tombstone for the old identity is appended below.
UPDATE cloud_chat_user_sync_events event
SET payload = jsonb_set(
    event.payload,
    '{sessionId}',
    to_jsonb(legacy.quarantine_session_id),
    false
)
FROM _legacy_support_conversations legacy
WHERE event.account_id = legacy.account_id
  AND event.payload ->> 'sessionId' = legacy.support_session_id;

UPDATE cloud_chat_user_sync_events event
SET payload = jsonb_set(
    event.payload,
    '{conversation,legacy_session_id}',
    to_jsonb(legacy.quarantine_session_id),
    false
)
FROM _legacy_support_conversations legacy
WHERE event.account_id = legacy.account_id
  AND event.payload #>> '{conversation,legacy_session_id}' = legacy.support_session_id;

UPDATE cloud_chat_conversations conversation
SET legacy_session_id = legacy.quarantine_session_id,
    version = conversation.version + 1,
    updated_at = now()
FROM _legacy_support_conversations legacy
WHERE conversation.conversation_id = legacy.conversation_id;

-- Hide the retained private transcript without reserving the real Support
-- identity. The user can receive a clean direct Support conversation next.
INSERT INTO cloud_account_session_visibility (
    account_id,
    session_id,
    hidden_at,
    deleted_at,
    updated_at
)
SELECT account_id,
       quarantine_session_id,
       NULL,
       now()::text,
       now()::text
FROM _legacy_support_conversations
ON CONFLICT (account_id, session_id) DO UPDATE SET
    hidden_at = NULL,
    deleted_at = EXCLUDED.deleted_at,
    updated_at = EXCLUDED.updated_at;

INSERT INTO cloud_chat_user_sync_heads (account_id, last_seq, min_seq)
SELECT account_id, 0, 0
FROM _legacy_support_conversations
ON CONFLICT (account_id) DO NOTHING;

CREATE TEMP TABLE _legacy_support_tombstones ON COMMIT DROP AS
WITH advanced AS (
    UPDATE cloud_chat_user_sync_heads head
    SET last_seq = head.last_seq + 1
    FROM _legacy_support_conversations legacy
    WHERE head.account_id = legacy.account_id
    RETURNING head.account_id, head.last_seq
)
SELECT advanced.account_id,
       advanced.last_seq,
       legacy.conversation_id,
       legacy.support_session_id
FROM advanced
JOIN _legacy_support_conversations legacy USING (account_id);

INSERT INTO cloud_chat_user_sync_events (
    account_id,
    stream_seq,
    event_id,
    protocol_version,
    event_type,
    conversation_id,
    entity_id,
    entity_version,
    critical,
    payload,
    occurred_at
)
SELECT account_id,
       last_seq,
       md5('legacy-support-session-deleted:' || conversation_id::text)::uuid,
       2,
       'session.deleted',
       NULL,
       NULL,
       NULL,
       TRUE,
       jsonb_build_object(
           'sessionId', support_session_id,
           'deletedAt', now()::text
       ),
       now()
FROM _legacy_support_tombstones;
