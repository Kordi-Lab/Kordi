WITH ranked AS (
  SELECT conversation_id,
         row_number() OVER (
           PARTITION BY coalesce(group_space_id, legacy_session_id, conversation_id::text)
           ORDER BY created_at, conversation_id
         ) AS channel_number
  FROM cloud_chat_conversations
  WHERE kind = 'group'
)
UPDATE cloud_chat_conversations AS conversation
SET shared_title = 'Channel ' || ranked.channel_number,
    version = version + 1,
    updated_at = now()
FROM ranked
WHERE ranked.conversation_id = conversation.conversation_id
  AND (
    conversation.shared_title IS NULL
    OR btrim(conversation.shared_title) = ''
    OR lower(btrim(conversation.shared_title)) IN (
      'new chat', 'new session', 'untitled session', 'session'
    )
  );
