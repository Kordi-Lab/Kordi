-- Retire development seed rows that were incorrectly created as direct
-- conversations, notify active clients, and prevent non-canonical direct
-- session identities from being inserted again.
CREATE TEMP TABLE _obsolete_seed_direct_conversations ON COMMIT DROP AS
SELECT conversation_id, legacy_session_id
FROM cloud_chat_conversations
WHERE kind = 'direct'
  AND legacy_session_id LIKE 'session:seed:%';

CREATE TEMP TABLE _obsolete_seed_direct_recipients ON COMMIT DROP AS
SELECT target.conversation_id,
       target.legacy_session_id,
       member.account_id
FROM _obsolete_seed_direct_conversations target
JOIN cloud_chat_conversation_members member USING (conversation_id)
WHERE member.membership_state = 'active';

INSERT INTO cloud_chat_user_sync_heads (account_id, last_seq, min_seq)
SELECT DISTINCT account_id, 0, 0
FROM _obsolete_seed_direct_recipients
ON CONFLICT (account_id) DO NOTHING;

CREATE TEMP TABLE _obsolete_seed_direct_tombstones ON COMMIT DROP AS
WITH ranked AS (
    SELECT recipient.*,
           row_number() OVER (
               PARTITION BY recipient.account_id
               ORDER BY recipient.conversation_id
           )::BIGINT AS ordinal,
           count(*) OVER (PARTITION BY recipient.account_id)::BIGINT AS total
    FROM _obsolete_seed_direct_recipients recipient
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
       ranked.legacy_session_id
FROM ranked
JOIN advanced USING (account_id);

DELETE FROM cloud_session_forks fork
USING _obsolete_seed_direct_conversations target
WHERE fork.fork_session_id = target.legacy_session_id
   OR fork.parent_session_id = target.legacy_session_id;

DELETE FROM cloud_session_tasks task
USING _obsolete_seed_direct_conversations target
WHERE task.session_id = target.legacy_session_id;

DELETE FROM cloud_session_artifacts artifact
USING _obsolete_seed_direct_conversations target
WHERE artifact.session_id = target.legacy_session_id;

DELETE FROM cloud_session_shared_pins pin
USING _obsolete_seed_direct_conversations target
WHERE pin.session_id = target.legacy_session_id;

DELETE FROM cloud_account_session_pins pin
USING _obsolete_seed_direct_conversations target
WHERE pin.session_id = target.legacy_session_id;

DELETE FROM cloud_account_session_visibility visibility
USING _obsolete_seed_direct_conversations target
WHERE visibility.session_id = target.legacy_session_id;

DELETE FROM cloud_agent_fallback_runs run
USING _obsolete_seed_direct_conversations target
WHERE run.session_id = target.legacy_session_id;

DELETE FROM cloud_agent_sandboxes sandbox
USING _obsolete_seed_direct_conversations target
WHERE sandbox.session_id = target.legacy_session_id;

DELETE FROM scheduled_tool_tasks task
USING _obsolete_seed_direct_conversations target
WHERE task.tool_payload_json ->> 'sessionId' = target.legacy_session_id;

DELETE FROM cloud_chat_client_operations operation
USING _obsolete_seed_direct_conversations target
WHERE operation.result ->> 'sessionId' = target.legacy_session_id
   OR operation.result #>> '{conversation,legacy_session_id}' = target.legacy_session_id;

DELETE FROM cloud_chat_conversations conversation
USING _obsolete_seed_direct_conversations target
WHERE conversation.conversation_id = target.conversation_id;

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
           'obsolete-seed-direct-deleted:'
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
           'sessionId', legacy_session_id,
           'deletedAt', now()::text
       ),
       now()
FROM _obsolete_seed_direct_tombstones;

ALTER TABLE cloud_chat_conversations
    ADD CONSTRAINT cloud_chat_direct_session_identity
    CHECK (
        kind <> 'direct'
        OR (
            legacy_session_id IS NOT NULL
            AND (
                legacy_session_id LIKE 'session:direct-person:%'
                OR legacy_session_id LIKE 'session:direct-agent:%'
                OR legacy_session_id LIKE 'session:direct-system-agent:%'
            )
        )
    ) NOT VALID;

ALTER TABLE cloud_chat_conversations
    VALIDATE CONSTRAINT cloud_chat_direct_session_identity;
