-- Recover public naming metadata, not personal member labels. Original
-- messages and member preferences are deliberately never rewritten here.
CREATE OR REPLACE FUNCTION pg_temp.kordi_channel_control(encoded TEXT)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE payload TEXT;
BEGIN
    payload := substring(encoded FROM length('kordi-cloud-group:') + 1);
    RETURN convert_from(decode(rpad(translate(payload, '-_', '+/'),
        length(payload) + ((4 - length(payload) % 4) % 4), '='), 'base64'), 'UTF8')::jsonb;
EXCEPTION WHEN data_exception THEN
    -- Invalid historical envelopes remain intact, but are not naming authority.
    RETURN NULL;
END;
$$;

CREATE TEMP TABLE kordi_channel_name_repairs ON COMMIT DROP AS
WITH eligible AS (
    SELECT conversation.*
    FROM cloud_chat_conversations conversation
    WHERE kind = 'group' AND (
        shared_title IS NULL OR btrim(shared_title) = ''
        OR (shared_title ~ '^Channel [1-9][0-9]*$' AND updated_at = (
            SELECT applied_at FROM cloud_schema_versions WHERE version = 79
        ))
    )
    FOR UPDATE
), decoded AS (
    SELECT conversation.conversation_id, conversation.legacy_session_id,
           message.conversation_sequence, message.sender_account_id,
           pg_temp.kordi_channel_control(block->>'text') AS envelope
    FROM eligible conversation
    JOIN cloud_chat_messages message USING (conversation_id)
    CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(message.content->'blocks') = 'array'
             THEN message.content->'blocks' ELSE '[]'::jsonb END
    ) block
    WHERE message.deleted_at IS NULL AND block->>'text' LIKE 'kordi-cloud-group:%'
      AND (message.sender_account_id = conversation.created_by_account_id OR EXISTS (
          SELECT 1 FROM cloud_chat_conversation_members member
          WHERE member.conversation_id = conversation.conversation_id
            AND member.account_id = message.sender_account_id AND member.role IN ('owner', 'admin')
      ))
), names AS (
    SELECT conversation_id, conversation_sequence,
           coalesce(
               CASE WHEN jsonb_typeof(envelope #> '{sessionTitle,title}') = 'string'
                    THEN nullif(btrim(envelope #>> '{sessionTitle,title}'), '') END,
               CASE WHEN jsonb_typeof(envelope->'groupTitle') = 'string'
                    THEN nullif(btrim(envelope->>'groupTitle'), '') END
           ) AS title,
           CASE WHEN jsonb_typeof(envelope #> '{sessionTitle,titleRevision}') = 'number'
                THEN (envelope #>> '{sessionTitle,titleRevision}')::numeric ELSE 0 END AS revision,
           CASE WHEN jsonb_typeof(envelope #> '{sessionTitle,updatedAtMs}') = 'number'
                THEN (envelope #>> '{sessionTitle,updatedAtMs}')::numeric ELSE 0 END AS title_time
    FROM decoded
    WHERE envelope->>'kind' = 'session-title-update'
      AND (envelope->>'groupId' = legacy_session_id OR envelope->>'groupId' = conversation_id::text)
      AND (envelope #>> '{actor,accountId}' IS NULL OR envelope #>> '{actor,accountId}' = sender_account_id)
), latest AS (
    SELECT DISTINCT ON (conversation_id) conversation_id, title
    FROM names WHERE title IS NOT NULL AND char_length(title) <= 200
    ORDER BY conversation_id, revision DESC, title_time DESC, conversation_sequence DESC
)
SELECT eligible.conversation_id, latest.title
FROM eligible LEFT JOIN latest USING (conversation_id)
WHERE latest.title IS NOT NULL AND eligible.shared_title IS DISTINCT FROM latest.title;

UPDATE cloud_chat_conversations conversation
SET shared_title = repair.title, version = conversation.version + 1, updated_at = now()
FROM kordi_channel_name_repairs repair
WHERE conversation.conversation_id = repair.conversation_id;

-- Existing clients must bootstrap the repaired projections instead of keeping
-- an already-consumed default title forever. Retain all sync-event history.
UPDATE cloud_chat_user_sync_heads head
SET last_seq = head.last_seq + 1, min_seq = head.last_seq + 1
WHERE EXISTS (
    SELECT 1 FROM cloud_chat_conversation_members member
    JOIN kordi_channel_name_repairs repair USING (conversation_id)
    WHERE member.account_id = head.account_id AND member.membership_state = 'active'
);

DROP FUNCTION pg_temp.kordi_channel_control(TEXT);
