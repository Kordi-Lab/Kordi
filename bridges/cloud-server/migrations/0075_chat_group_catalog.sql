ALTER TABLE cloud_chat_conversations
    ADD COLUMN IF NOT EXISTS group_space_id TEXT,
    ADD COLUMN IF NOT EXISTS group_title TEXT;

WITH encoded AS (
    SELECT message.conversation_id,
           message.created_at,
           SUBSTRING(block->>'text' FROM 19) AS payload
    FROM cloud_chat_messages message
    CROSS JOIN LATERAL jsonb_array_elements(message.content->'blocks') block
    WHERE block->>'text' LIKE 'kordi-cloud-group:%'
),
decoded AS (
    SELECT conversation_id,
           created_at,
           convert_from(
               decode(
                   rpad(
                       translate(payload, '-_', '+/'),
                       length(payload) + ((4 - length(payload) % 4) % 4),
                       '='
                   ),
                   'base64'
               ),
               'UTF8'
           )::jsonb AS envelope
    FROM encoded
),
latest_space AS (
    SELECT DISTINCT ON (conversation_id)
           conversation_id,
           COALESCE(
               NULLIF(envelope->>'groupSpaceId', ''),
               NULLIF(envelope->>'groupId', '')
           ) AS group_space_id
    FROM decoded
    WHERE COALESCE(
        NULLIF(envelope->>'groupSpaceId', ''),
        NULLIF(envelope->>'groupId', '')
    ) IS NOT NULL
    ORDER BY conversation_id, created_at DESC
)
UPDATE cloud_chat_conversations conversation
SET group_space_id = latest_space.group_space_id
FROM latest_space
WHERE conversation.conversation_id = latest_space.conversation_id;

WITH encoded AS (
    SELECT message.created_at,
           SUBSTRING(block->>'text' FROM 19) AS payload
    FROM cloud_chat_messages message
    CROSS JOIN LATERAL jsonb_array_elements(message.content->'blocks') block
    WHERE block->>'text' LIKE 'kordi-cloud-group:%'
),
decoded AS (
    SELECT created_at,
           convert_from(
               decode(
                   rpad(
                       translate(payload, '-_', '+/'),
                       length(payload) + ((4 - length(payload) % 4) % 4),
                       '='
                   ),
                   'base64'
               ),
               'UTF8'
           )::jsonb AS envelope
    FROM encoded
),
latest_title AS (
    SELECT DISTINCT ON (group_space_id)
           group_space_id,
           group_title
    FROM (
        SELECT COALESCE(
                   NULLIF(envelope->>'groupSpaceId', ''),
                   NULLIF(envelope->>'groupId', '')
               ) AS group_space_id,
               NULLIF(BTRIM(envelope->>'groupTitle'), '') AS group_title,
               created_at
        FROM decoded
        WHERE envelope->>'kind' IN (
            'group-invite',
            'group-update',
            'group-title-update'
        )
    ) title
    WHERE group_space_id IS NOT NULL AND group_title IS NOT NULL
    ORDER BY group_space_id, created_at DESC
)
UPDATE cloud_chat_conversations conversation
SET group_title = latest_title.group_title
FROM latest_title
WHERE conversation.group_space_id = latest_title.group_space_id;

CREATE INDEX IF NOT EXISTS idx_cloud_chat_conversations_group_space
    ON cloud_chat_conversations(group_space_id)
    WHERE group_space_id IS NOT NULL;
