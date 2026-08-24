-- Scope the historical default My Kordi session to its owning account. New
-- clients already send the scoped identity; the server also rewrites the old
-- reserved identity so older clients cannot recreate the global collision.
CREATE TEMP TABLE _default_self_agent_session_scope ON COMMIT DROP AS
SELECT conversation_id,
       created_by_account_id AS account_id,
       'session:self-agent:' || created_by_account_id || ':default' AS session_id
FROM cloud_chat_conversations
WHERE legacy_session_id = 'session:self-agent:default'
  AND kind = 'ai';

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM _default_self_agent_session_scope scoped
        LEFT JOIN cloud_chat_conversation_members member
          ON member.conversation_id = scoped.conversation_id
         AND member.membership_state = 'active'
        GROUP BY scoped.conversation_id, scoped.account_id
        HAVING count(member.account_id) <> 1
            OR bool_or(member.account_id = scoped.account_id) IS NOT TRUE
    ) THEN
        RAISE EXCEPTION 'cannot scope default self-agent session: membership is not private';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM _default_self_agent_session_scope scoped
        JOIN cloud_chat_conversations conversation
          ON conversation.legacy_session_id = scoped.session_id
         AND conversation.conversation_id <> scoped.conversation_id
    ) THEN
        RAISE EXCEPTION 'cannot scope default self-agent session: target identity already exists';
    END IF;
END $$;

UPDATE cloud_session_forks fork
SET fork_session_id = scoped.session_id
FROM _default_self_agent_session_scope scoped
WHERE fork.fork_session_id = 'session:self-agent:default';

UPDATE cloud_session_forks fork
SET parent_session_id = scoped.session_id
FROM _default_self_agent_session_scope scoped
WHERE fork.parent_session_id = 'session:self-agent:default';

UPDATE cloud_session_tasks task
SET session_id = scoped.session_id
FROM _default_self_agent_session_scope scoped
WHERE task.session_id = 'session:self-agent:default';

UPDATE cloud_session_artifacts artifact
SET session_id = scoped.session_id
FROM _default_self_agent_session_scope scoped
WHERE artifact.session_id = 'session:self-agent:default';

UPDATE cloud_session_shared_pins pin
SET session_id = scoped.session_id
FROM _default_self_agent_session_scope scoped
WHERE pin.session_id = 'session:self-agent:default';

UPDATE cloud_account_session_pins pin
SET session_id = scoped.session_id
FROM _default_self_agent_session_scope scoped
WHERE pin.session_id = 'session:self-agent:default';

UPDATE cloud_account_session_visibility visibility
SET session_id = scoped.session_id
FROM _default_self_agent_session_scope scoped
WHERE visibility.session_id = 'session:self-agent:default';

UPDATE cloud_agent_fallback_runs run
SET session_id = scoped.session_id
FROM _default_self_agent_session_scope scoped
WHERE run.session_id = 'session:self-agent:default';

-- Keep workspace_key stable so retained run artifacts preserve their storage
-- identity. New runs use a new sandbox derived from the scoped session id.
UPDATE cloud_agent_sandboxes sandbox
SET session_id = scoped.session_id
FROM _default_self_agent_session_scope scoped
WHERE sandbox.session_id = 'session:self-agent:default';

UPDATE scheduled_tool_tasks task
SET tool_payload_json = jsonb_set(
    task.tool_payload_json,
    '{sessionId}',
    to_jsonb(scoped.session_id),
    false
)
FROM _default_self_agent_session_scope scoped
WHERE task.owner_account_id = scoped.account_id
  AND task.tool_payload_json ->> 'sessionId' = 'session:self-agent:default';

UPDATE cloud_chat_user_sync_events event
SET payload = jsonb_set(event.payload, '{sessionId}', to_jsonb(scoped.session_id), false)
FROM _default_self_agent_session_scope scoped
WHERE event.account_id = scoped.account_id
  AND event.payload ->> 'sessionId' = 'session:self-agent:default';

UPDATE cloud_chat_user_sync_events event
SET payload = jsonb_set(
    event.payload,
    '{conversation,legacy_session_id}',
    to_jsonb(scoped.session_id),
    false
)
FROM _default_self_agent_session_scope scoped
WHERE event.account_id = scoped.account_id
  AND event.payload #>> '{conversation,legacy_session_id}' = 'session:self-agent:default';

UPDATE cloud_chat_conversations conversation
SET legacy_session_id = scoped.session_id,
    client_operation_id = md5(
        'account-scoped-default-self-agent:' || conversation.conversation_id::text
    )::uuid,
    creation_fingerprint = 'account-scoped-default-self-agent:' || md5(scoped.session_id)
FROM _default_self_agent_session_scope scoped
WHERE conversation.conversation_id = scoped.conversation_id;
