-- Some older Support sessions were backfilled as groups or otherwise carried
-- an invalid membership shape. Preserve those transcripts under quarantined
-- identities and reserve the stable Support identity for one direct
-- conversation between the requester and the system-managed Support owner.
CREATE TEMP TABLE _invalid_support_conversations ON COMMIT DROP AS
SELECT conversation.conversation_id,
       conversation.created_by_account_id AS account_id,
       conversation.legacy_session_id AS support_session_id,
       'session:quarantined-support:' || conversation.conversation_id::text AS quarantine_session_id
FROM cloud_chat_conversations conversation
WHERE conversation.legacy_session_id =
      'session:direct-system-agent:'
      || conversation.created_by_account_id
      || ':cloud_agent_kordi_support'
  AND NOT (
      conversation.kind = 'direct'
      AND (
          SELECT count(*)
          FROM cloud_chat_conversation_members member
          WHERE member.conversation_id = conversation.conversation_id
            AND member.membership_state = 'active'
      ) = 2
      AND EXISTS (
          SELECT 1
          FROM cloud_chat_conversation_members member
          WHERE member.conversation_id = conversation.conversation_id
            AND member.account_id = conversation.created_by_account_id
            AND member.membership_state = 'active'
      )
      AND EXISTS (
          SELECT 1
          FROM cloud_chat_conversation_members member
          JOIN cloud_agent_definitions agent
            ON agent.agent_id = 'cloud_agent_kordi_support'
           AND agent.owner_account_id = member.account_id
           AND agent.status = 'active'
           AND agent.is_system_managed = TRUE
          WHERE member.conversation_id = conversation.conversation_id
            AND member.membership_state = 'active'
      )
  );

CREATE TEMP TABLE _invalid_support_recipients ON COMMIT DROP AS
SELECT DISTINCT invalid.conversation_id,
       invalid.support_session_id,
       invalid.quarantine_session_id,
       member.account_id
FROM _invalid_support_conversations invalid
JOIN cloud_chat_conversation_members member USING (conversation_id);

UPDATE cloud_session_forks fork
SET fork_session_id = invalid.quarantine_session_id
FROM _invalid_support_conversations invalid
WHERE fork.fork_session_id = invalid.support_session_id;

UPDATE cloud_session_forks fork
SET parent_session_id = invalid.quarantine_session_id
FROM _invalid_support_conversations invalid
WHERE fork.parent_session_id = invalid.support_session_id;

UPDATE cloud_session_tasks task
SET session_id = invalid.quarantine_session_id
FROM _invalid_support_conversations invalid
WHERE task.session_id = invalid.support_session_id;

UPDATE cloud_session_artifacts artifact
SET session_id = invalid.quarantine_session_id
FROM _invalid_support_conversations invalid
WHERE artifact.session_id = invalid.support_session_id;

UPDATE cloud_session_shared_pins pin
SET session_id = invalid.quarantine_session_id
FROM _invalid_support_conversations invalid
WHERE pin.session_id = invalid.support_session_id;

UPDATE cloud_account_session_pins pin
SET session_id = invalid.quarantine_session_id
FROM _invalid_support_conversations invalid
WHERE pin.session_id = invalid.support_session_id;

UPDATE cloud_account_session_visibility visibility
SET session_id = invalid.quarantine_session_id
FROM _invalid_support_conversations invalid
WHERE visibility.session_id = invalid.support_session_id;

UPDATE cloud_agent_fallback_runs run
SET session_id = invalid.quarantine_session_id
FROM _invalid_support_conversations invalid
WHERE run.session_id = invalid.support_session_id;

UPDATE cloud_agent_sandboxes sandbox
SET session_id = invalid.quarantine_session_id
FROM _invalid_support_conversations invalid
WHERE sandbox.session_id = invalid.support_session_id;

UPDATE scheduled_tool_tasks task
SET tool_payload_json = jsonb_set(
    task.tool_payload_json,
    '{sessionId}',
    to_jsonb(invalid.quarantine_session_id),
    false
)
FROM _invalid_support_conversations invalid
WHERE task.owner_account_id = invalid.account_id
  AND task.tool_payload_json ->> 'sessionId' = invalid.support_session_id;

UPDATE cloud_chat_user_sync_events event
SET payload = jsonb_set(
    event.payload,
    '{sessionId}',
    to_jsonb(invalid.quarantine_session_id),
    false
)
FROM _invalid_support_conversations invalid
WHERE event.payload ->> 'sessionId' = invalid.support_session_id;

UPDATE cloud_chat_user_sync_events event
SET payload = jsonb_set(
    event.payload,
    '{conversation,legacy_session_id}',
    to_jsonb(invalid.quarantine_session_id),
    false
)
FROM _invalid_support_conversations invalid
WHERE event.payload #>> '{conversation,legacy_session_id}' = invalid.support_session_id;

UPDATE cloud_chat_conversations conversation
SET legacy_session_id = invalid.quarantine_session_id,
    version = conversation.version + 1,
    updated_at = now()
FROM _invalid_support_conversations invalid
WHERE conversation.conversation_id = invalid.conversation_id;

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
FROM _invalid_support_recipients
ON CONFLICT (account_id, session_id) DO UPDATE SET
    hidden_at = NULL,
    deleted_at = EXCLUDED.deleted_at,
    updated_at = EXCLUDED.updated_at;

INSERT INTO cloud_chat_user_sync_heads (account_id, last_seq, min_seq)
SELECT DISTINCT account_id, 0, 0
FROM _invalid_support_recipients
ON CONFLICT (account_id) DO NOTHING;

CREATE TEMP TABLE _invalid_support_tombstones ON COMMIT DROP AS
WITH ranked AS (
    SELECT recipient.*,
           row_number() OVER (
               PARTITION BY recipient.account_id
               ORDER BY recipient.conversation_id
           )::BIGINT AS ordinal,
           count(*) OVER (PARTITION BY recipient.account_id)::BIGINT AS total
    FROM _invalid_support_recipients recipient
), advanced AS (
    UPDATE cloud_chat_user_sync_heads head
    SET last_seq = head.last_seq + totals.total
    FROM (
        SELECT account_id, max(total)::BIGINT AS total
        FROM ranked
        GROUP BY account_id
    ) totals
    WHERE head.account_id = totals.account_id
    RETURNING head.account_id, head.last_seq
)
SELECT ranked.account_id,
       advanced.last_seq - ranked.total + ranked.ordinal AS stream_seq,
       ranked.conversation_id,
       ranked.support_session_id
FROM ranked
JOIN advanced USING (account_id);

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
       stream_seq,
       md5(
           'invalid-support-session-deleted:'
           || conversation_id::text
           || ':'
           || account_id
       )::uuid,
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
FROM _invalid_support_tombstones;
