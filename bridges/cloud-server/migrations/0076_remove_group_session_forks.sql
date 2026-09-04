-- Fork lineage belongs only to Agent conversations. Remove obsolete group
-- forks and their copied child conversations while preserving ai -> ai forks.
CREATE TEMP TABLE removed_group_session_forks ON COMMIT DROP AS
SELECT fork.*
FROM cloud_session_forks fork
JOIN cloud_chat_conversations parent
  ON parent.legacy_session_id = fork.parent_session_id
  OR parent.conversation_id::text = fork.parent_session_id
WHERE parent.kind = 'group';

CREATE TEMP TABLE removed_group_fork_conversations ON COMMIT DROP AS
SELECT conversation.conversation_id
FROM cloud_chat_conversations conversation
JOIN removed_group_session_forks fork
  ON conversation.legacy_session_id = fork.fork_session_id
  OR conversation.conversation_id::text = fork.fork_session_id;

DELETE FROM cloud_chat_user_sync_events
WHERE event_type = 'session-forked'
  AND payload->>'forkSessionId' IN (
    SELECT fork_session_id FROM removed_group_session_forks
  );

DO $$
DECLARE
  session_table TEXT;
BEGIN
  FOREACH session_table IN ARRAY ARRAY[
    'cloud_account_session_pins',
    'cloud_account_session_visibility',
    'cloud_agent_delegations',
    'cloud_agent_fallback_runs',
    'cloud_agent_group_delegation_policies',
    'cloud_agent_sandboxes',
    'cloud_group_memberships',
    'cloud_group_spaces',
    'cloud_session_artifacts',
    'cloud_session_shared_pins',
    'cloud_session_tasks',
    'cloud_support_tickets'
  ] LOOP
    IF to_regclass('public.' || session_table) IS NOT NULL THEN
      EXECUTE format(
        'DELETE FROM %I WHERE session_id IN (SELECT fork_session_id FROM removed_group_session_forks)',
        session_table
      );
    END IF;
  END LOOP;
END $$;

DELETE FROM cloud_session_forks
WHERE fork_session_id IN (
  SELECT fork_session_id FROM removed_group_session_forks
);

DELETE FROM cloud_chat_conversations
WHERE conversation_id IN (
  SELECT conversation_id FROM removed_group_fork_conversations
);
