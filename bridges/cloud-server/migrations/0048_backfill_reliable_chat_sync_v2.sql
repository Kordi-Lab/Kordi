-- One-time, idempotent cutover of retained v1 chat history into the canonical
-- v2 model. The old rows remain as an audit source, but product reads and
-- writes no longer depend on them.
--
-- Group sends were historically fanned out into one cloud_messages row per
-- recipient. This migration collapses those copies into one timeline item,
-- assigns deterministic canonical UUIDs, and preserves an explicit mapping
-- from every retained legacy row.
CREATE TEMP TABLE _chat_v2_legacy_conversation_base ON COMMIT DROP AS
WITH normalized AS (
    SELECT message.*,
           COALESCE(
               NULLIF(btrim(message.session_id), ''),
               CASE
                   WHEN message.from_account_id = message.to_account_id
                       THEN 'legacy:self:' || message.from_account_id
                   ELSE 'session:direct-person:'
                        || LEAST(message.from_account_id, message.to_account_id)
                        || ':'
                        || GREATEST(message.from_account_id, message.to_account_id)
               END
           ) AS conversation_key
    FROM cloud_messages message
), conversation_accounts AS (
    SELECT conversation_key, from_account_id AS account_id FROM normalized
    UNION
    SELECT conversation_key, to_account_id AS account_id FROM normalized
), account_counts AS (
    SELECT conversation_key, count(*) AS account_count
    FROM conversation_accounts
    GROUP BY conversation_key
), aggregated AS (
    SELECT normalized.conversation_key,
           bool_or(
               normalized.conversation_key LIKE 'session:group:%'
               OR normalized.body LIKE 'kordi-cloud-group:%'
           ) AS has_group_shape,
           bool_and(normalized.from_account_id = normalized.to_account_id) AS self_only,
           min(normalized.created_at::timestamptz) AS created_at,
           max(normalized.created_at::timestamptz) AS updated_at,
           (array_agg(
               normalized.from_account_id
               ORDER BY normalized.created_at::timestamptz, normalized.message_id
           ))[1] AS first_sender_account_id
    FROM normalized
    GROUP BY normalized.conversation_key
)
SELECT aggregated.conversation_key,
       CASE
           WHEN aggregated.has_group_shape OR account_counts.account_count > 2 THEN 'group'
           WHEN aggregated.self_only THEN 'ai'
           ELSE 'direct'
       END AS kind,
       aggregated.created_at,
       aggregated.updated_at,
       aggregated.first_sender_account_id
FROM aggregated
JOIN account_counts USING (conversation_key);
CREATE TEMP TABLE _chat_v2_legacy_group_envelopes ON COMMIT DROP AS
WITH encoded AS (
    SELECT COALESCE(
               NULLIF(btrim(message.session_id), ''),
               CASE
                   WHEN message.from_account_id = message.to_account_id
                       THEN 'legacy:self:' || message.from_account_id
                   ELSE 'session:direct-person:'
                        || LEAST(message.from_account_id, message.to_account_id)
                        || ':'
                        || GREATEST(message.from_account_id, message.to_account_id)
               END
           ) AS conversation_key,
           substring(message.body FROM length('kordi-cloud-group:') + 1) AS encoded,
           message.created_at::timestamptz AS created_at,
           message.message_id
    FROM cloud_messages message
    WHERE message.body LIKE 'kordi-cloud-group:%'
), parsed AS (
    SELECT conversation_key,
           convert_from(
               decode(
                   translate(encoded, '-_', '+/')
                   || repeat('=', (4 - length(encoded) % 4) % 4),
                   'base64'
               ),
               'UTF8'
           )::jsonb AS envelope,
           created_at,
           message_id
    FROM encoded
)
SELECT DISTINCT ON (conversation_key)
       conversation_key,
       envelope
FROM parsed
ORDER BY conversation_key, created_at DESC, message_id DESC;
CREATE TEMP TABLE _chat_v2_legacy_group_titles ON COMMIT DROP AS
WITH encoded AS (
    SELECT COALESCE(
               NULLIF(btrim(message.session_id), ''),
               CASE
                   WHEN message.from_account_id = message.to_account_id
                       THEN 'legacy:self:' || message.from_account_id
                   ELSE 'session:direct-person:'
                        || LEAST(message.from_account_id, message.to_account_id)
                        || ':'
                        || GREATEST(message.from_account_id, message.to_account_id)
               END
           ) AS conversation_key,
           substring(message.body FROM length('kordi-cloud-group:') + 1) AS encoded,
           message.created_at::timestamptz AS created_at,
           message.message_id
    FROM cloud_messages message
    WHERE message.body LIKE 'kordi-cloud-group:%'
), parsed AS (
    SELECT conversation_key,
           convert_from(
               decode(
                   translate(encoded, '-_', '+/')
                   || repeat('=', (4 - length(encoded) % 4) % 4),
                   'base64'
               ),
               'UTF8'
           )::jsonb AS envelope,
           created_at,
           message_id
    FROM encoded
)
SELECT DISTINCT ON (conversation_key)
       conversation_key,
       NULLIF(left(btrim(envelope ->> 'groupTitle'), 160), '') AS shared_title
FROM parsed
WHERE NULLIF(btrim(envelope ->> 'groupTitle'), '') IS NOT NULL
ORDER BY conversation_key, created_at DESC, message_id DESC;
CREATE TEMP TABLE _chat_v2_legacy_conversations ON COMMIT DROP AS
SELECT base.conversation_key,
       md5('chat-v2-legacy-conversation:' || base.conversation_key)::uuid AS conversation_id,
       base.kind,
       COALESCE(
           CASE WHEN base.kind = 'group' THEN group_title.shared_title END,
           CASE WHEN base.kind = 'group'
               THEN NULLIF(left(btrim(legacy_title.title), 160), '')
           END
       ) AS shared_title,
       COALESCE(
           CASE
               WHEN envelope.envelope ->> 'createdByAccountId' IN (
                   SELECT account_id FROM cloud_accounts
               ) THEN envelope.envelope ->> 'createdByAccountId'
           END,
           base.first_sender_account_id
       ) AS created_by_account_id,
       base.created_at,
       base.updated_at
FROM _chat_v2_legacy_conversation_base base
LEFT JOIN _chat_v2_legacy_group_envelopes envelope USING (conversation_key)
LEFT JOIN _chat_v2_legacy_group_titles group_title USING (conversation_key)
LEFT JOIN cloud_session_titles legacy_title
  ON legacy_title.session_id = base.conversation_key;
INSERT INTO cloud_chat_conversations (
    conversation_id,
    kind,
    shared_title,
    created_by_account_id,
    client_operation_id,
    creation_fingerprint,
    legacy_session_id,
    created_at,
    updated_at
)
SELECT conversation_id,
       kind,
       shared_title,
       created_by_account_id,
       md5('chat-v2-legacy-conversation-operation:' || conversation_key)::uuid,
       'legacy-v1:' || md5(conversation_key),
       conversation_key,
       created_at,
       updated_at
FROM _chat_v2_legacy_conversations
ON CONFLICT DO NOTHING;
CREATE TEMP TABLE _chat_v2_legacy_conversation_map ON COMMIT DROP AS
SELECT source.conversation_key,
       canonical.conversation_id,
       canonical.kind,
       canonical.created_by_account_id,
       canonical.created_at,
       canonical.updated_at
FROM _chat_v2_legacy_conversations source
JOIN cloud_chat_conversations canonical
  ON canonical.legacy_session_id = source.conversation_key;
CREATE TEMP TABLE _chat_v2_legacy_members ON COMMIT DROP AS
WITH normalized AS (
    SELECT COALESCE(
               NULLIF(btrim(message.session_id), ''),
               CASE
                   WHEN message.from_account_id = message.to_account_id
                       THEN 'legacy:self:' || message.from_account_id
                   ELSE 'session:direct-person:'
                        || LEAST(message.from_account_id, message.to_account_id)
                        || ':'
                        || GREATEST(message.from_account_id, message.to_account_id)
               END
           ) AS conversation_key,
           message.from_account_id,
           message.to_account_id
    FROM cloud_messages message
), envelope_members AS (
    SELECT envelope.conversation_key,
           NULLIF(btrim(participant.value ->> 'accountId'), '') AS account_id
    FROM _chat_v2_legacy_group_envelopes envelope
    CROSS JOIN LATERAL jsonb_array_elements(
        COALESCE(envelope.envelope -> 'participants', '[]'::jsonb)
    ) participant(value)
), fallback_members AS (
    SELECT normalized.conversation_key, normalized.from_account_id AS account_id
    FROM normalized
    JOIN _chat_v2_legacy_conversation_base base USING (conversation_key)
    WHERE base.kind <> 'group'
       OR NOT EXISTS (
           SELECT 1
           FROM envelope_members envelope
           WHERE envelope.conversation_key = normalized.conversation_key
             AND envelope.account_id IS NOT NULL
       )
    UNION
    SELECT normalized.conversation_key, normalized.to_account_id AS account_id
    FROM normalized
    JOIN _chat_v2_legacy_conversation_base base USING (conversation_key)
    WHERE base.kind <> 'group'
       OR NOT EXISTS (
           SELECT 1
           FROM envelope_members envelope
           WHERE envelope.conversation_key = normalized.conversation_key
             AND envelope.account_id IS NOT NULL
       )
), desired AS (
    SELECT conversation_key, account_id FROM envelope_members WHERE account_id IS NOT NULL
    UNION
    SELECT conversation_key, account_id FROM fallback_members
)
SELECT DISTINCT desired.conversation_key, desired.account_id
FROM desired
JOIN cloud_accounts account ON account.account_id = desired.account_id;
INSERT INTO cloud_chat_conversation_members (
    conversation_id,
    account_id,
    role,
    joined_at
)
SELECT conversation.conversation_id,
       member.account_id,
       CASE
           WHEN member.account_id = conversation.created_by_account_id THEN 'owner'
           ELSE 'member'
       END,
       conversation.created_at
FROM _chat_v2_legacy_members member
JOIN _chat_v2_legacy_conversation_map conversation USING (conversation_key)
ON CONFLICT (conversation_id, account_id) DO NOTHING;
CREATE TEMP TABLE _chat_v2_legacy_logical_messages ON COMMIT DROP AS
WITH normalized AS (
    SELECT message.*,
           COALESCE(
               NULLIF(btrim(message.session_id), ''),
               CASE
                   WHEN message.from_account_id = message.to_account_id
                       THEN 'legacy:self:' || message.from_account_id
                   ELSE 'session:direct-person:'
                        || LEAST(message.from_account_id, message.to_account_id)
                        || ':'
                        || GREATEST(message.from_account_id, message.to_account_id)
               END
           ) AS conversation_key
    FROM cloud_messages message
), keyed AS (
    SELECT normalized.*,
           CASE
               WHEN base.kind = 'group' THEN
                   normalized.from_account_id || ':' ||
                   COALESCE(
                       'client:' || NULLIF(btrim(normalized.client_message_id), '')
                           || ':body:' || md5(normalized.body),
                       'fallback:' || normalized.created_at || ':body:' || md5(normalized.body)
                   )
               ELSE 'row:' || normalized.message_id
           END AS logical_key
    FROM normalized
    JOIN _chat_v2_legacy_conversation_base base USING (conversation_key)
), collapsed AS (
    SELECT conversation_key,
           logical_key,
           min(from_account_id) AS sender_account_id,
           min(body) AS body,
           min(created_at::timestamptz) AS created_at
    FROM keyed
    GROUP BY conversation_key, logical_key
), sequenced AS (
    SELECT collapsed.*,
           row_number() OVER (
               PARTITION BY conversation_key
               ORDER BY created_at, logical_key
           )::bigint AS conversation_sequence
    FROM collapsed
)
SELECT sequenced.conversation_key,
       sequenced.logical_key,
       md5(
           'chat-v2-legacy-message:' || sequenced.conversation_key || ':' || sequenced.logical_key
       )::uuid AS message_id,
       md5(
           'chat-v2-legacy-client:' || sequenced.sender_account_id || ':'
           || sequenced.conversation_key || ':' || sequenced.logical_key
       )::uuid AS client_message_id,
       sequenced.conversation_sequence,
       sequenced.sender_account_id,
       sequenced.body,
       sequenced.created_at
FROM sequenced;
INSERT INTO cloud_chat_messages (
    message_id,
    conversation_id,
    conversation_sequence,
    sender_account_id,
    client_message_id,
    request_fingerprint,
    message_kind,
    content,
    created_at
)
SELECT logical.message_id,
       conversation.conversation_id,
       logical.conversation_sequence,
       logical.sender_account_id,
       logical.client_message_id,
       'legacy-v1:' || md5(logical.conversation_key || ':' || logical.logical_key),
       'text',
       jsonb_build_object(
           'schema', 1,
           'blocks', jsonb_build_array(
               jsonb_build_object('type', 'text', 'text', logical.body)
           ),
           'legacy_attachments', '[]'::jsonb
       ),
       logical.created_at
FROM _chat_v2_legacy_logical_messages logical
JOIN _chat_v2_legacy_conversation_map conversation USING (conversation_key)
ON CONFLICT DO NOTHING;
WITH progress AS (
    SELECT conversation.conversation_id,
           COALESCE(max(logical.conversation_sequence), 0) AS latest_sequence
    FROM _chat_v2_legacy_conversation_map conversation
    LEFT JOIN _chat_v2_legacy_logical_messages logical USING (conversation_key)
    GROUP BY conversation.conversation_id
)
UPDATE cloud_chat_conversations conversation
SET latest_message_sequence = GREATEST(conversation.latest_message_sequence, progress.latest_sequence),
    next_message_sequence = GREATEST(conversation.next_message_sequence, progress.latest_sequence + 1),
    updated_at = GREATEST(conversation.updated_at, source.updated_at)
FROM progress
JOIN _chat_v2_legacy_conversation_map source
  ON source.conversation_id = progress.conversation_id
WHERE conversation.conversation_id = progress.conversation_id;
WITH normalized AS ( SELECT message.*,
COALESCE( NULLIF(btrim(message.session_id), ''),
CASE WHEN message.from_account_id = message.to_account_id
THEN 'legacy:self:' || message.from_account_id ELSE 'session:direct-person:'
|| LEAST(message.from_account_id, message.to_account_id) || ':'
|| GREATEST(message.from_account_id, message.to_account_id) END
) AS conversation_key FROM cloud_messages message
), keyed AS ( SELECT normalized.*,
CASE WHEN base.kind = 'group' THEN
normalized.from_account_id || ':' || COALESCE(
'client:' || NULLIF(btrim(normalized.client_message_id), '') || ':body:' || md5(normalized.body),
'fallback:' || normalized.created_at || ':body:' || md5(normalized.body) )
ELSE 'row:' || normalized.message_id END AS logical_key
FROM normalized JOIN _chat_v2_legacy_conversation_base base USING (conversation_key)
) INSERT INTO cloud_chat_legacy_message_map (
legacy_message_id, canonical_message_id,
recipient_account_id )
SELECT keyed.message_id, logical.message_id,
keyed.to_account_id FROM keyed
JOIN _chat_v2_legacy_logical_messages logical ON logical.conversation_key = keyed.conversation_key
AND logical.logical_key = keyed.logical_key ON CONFLICT DO NOTHING;
WITH distinct_links AS ( SELECT mapping.canonical_message_id AS message_id,
attachment.attachment_id, min(attachment.position) AS first_position
FROM cloud_chat_legacy_message_map mapping JOIN cloud_message_attachments attachment
ON attachment.message_id = mapping.legacy_message_id GROUP BY mapping.canonical_message_id, attachment.attachment_id
), ranked AS ( SELECT message_id,
attachment_id, (row_number() OVER (
PARTITION BY message_id ORDER BY first_position, attachment_id
) - 1)::integer AS position FROM distinct_links
) INSERT INTO cloud_chat_message_attachments (message_id, attachment_id, position)
SELECT message_id, attachment_id, position FROM ranked
ON CONFLICT DO NOTHING; WITH attachment_metadata AS (
SELECT DISTINCT ON (mapping.canonical_message_id, attachment.attachment_id) mapping.canonical_message_id AS message_id,
attachment.attachment_id, attachment.name,
attachment.kind, attachment.mime_type,
attachment.size_bytes, attachment.preview_url
FROM cloud_chat_legacy_message_map mapping JOIN cloud_message_attachments attachment
ON attachment.message_id = mapping.legacy_message_id ORDER BY mapping.canonical_message_id, attachment.attachment_id, attachment.position
), snapshots AS ( SELECT metadata.message_id,
jsonb_agg( jsonb_build_object(
'attachmentId', metadata.attachment_id, 'name', metadata.name,
'kind', metadata.kind, 'mimeType', metadata.mime_type,
'sizeBytes', metadata.size_bytes, 'previewUrl', metadata.preview_url
) ORDER BY link.position
) AS attachments FROM attachment_metadata metadata
JOIN cloud_chat_message_attachments link ON link.message_id = metadata.message_id
AND link.attachment_id = metadata.attachment_id GROUP BY metadata.message_id
) UPDATE cloud_chat_messages message
SET content = jsonb_set(message.content, '{legacy_attachments}', snapshots.attachments, true) FROM snapshots
WHERE message.message_id = snapshots.message_id; UPDATE cloud_chat_conversation_members member
SET personal_title = NULLIF(left(btrim(title.title), 160), ''), preferences_version = GREATEST(member.preferences_version, 1)
FROM cloud_session_titles title JOIN _chat_v2_legacy_conversation_map conversation
ON conversation.conversation_key = title.session_id WHERE member.conversation_id = conversation.conversation_id
AND member.account_id = title.updated_by_account_id AND NULLIF(btrim(title.title), '') IS NOT NULL;
WITH row_progress AS ( SELECT member.conversation_id,
member.account_id, COALESCE(max(message.conversation_sequence) FILTER (
WHERE message.sender_account_id = member.account_id OR (
legacy.to_account_id = member.account_id AND legacy.delivered_at IS NOT NULL
) ), 0) AS delivered_sequence,
COALESCE(max(message.conversation_sequence) FILTER ( WHERE message.sender_account_id = member.account_id
OR ( legacy.to_account_id = member.account_id
AND legacy.read_at IS NOT NULL )
), 0) AS read_sequence FROM cloud_chat_conversation_members member
JOIN _chat_v2_legacy_conversation_map conversation ON conversation.conversation_id = member.conversation_id
LEFT JOIN cloud_chat_messages message ON message.conversation_id = member.conversation_id
LEFT JOIN cloud_chat_legacy_message_map mapping ON mapping.canonical_message_id = message.message_id
LEFT JOIN cloud_messages legacy ON legacy.message_id = mapping.legacy_message_id
GROUP BY member.conversation_id, member.account_id ), cursor_progress AS (
SELECT member.conversation_id, member.account_id,
COALESCE(max(message.conversation_sequence), 0) AS read_sequence FROM cloud_chat_conversation_members member
JOIN _chat_v2_legacy_conversation_map conversation ON conversation.conversation_id = member.conversation_id
JOIN cloud_read_cursors cursor ON cursor.account_id = member.account_id
AND ( (
cursor.scope_kind = 'session' AND cursor.scope_id = conversation.conversation_key
) OR (
conversation.kind = 'direct' AND cursor.scope_kind = 'peer'
AND EXISTS ( SELECT 1
FROM cloud_chat_conversation_members peer WHERE peer.conversation_id = member.conversation_id
AND peer.account_id <> member.account_id AND peer.account_id = cursor.scope_id
) )
) JOIN cloud_chat_messages message
ON message.conversation_id = member.conversation_id AND message.created_at <= cursor.read_at::timestamptz
GROUP BY member.conversation_id, member.account_id ), combined AS (
SELECT row_progress.conversation_id, row_progress.account_id,
GREATEST( row_progress.delivered_sequence,
row_progress.read_sequence, COALESCE(cursor_progress.read_sequence, 0)
) AS delivered_sequence, GREATEST(
row_progress.read_sequence, COALESCE(cursor_progress.read_sequence, 0)
) AS read_sequence FROM row_progress
LEFT JOIN cursor_progress USING (conversation_id, account_id) )
UPDATE cloud_chat_conversation_members member SET last_delivered_sequence = GREATEST(
member.last_delivered_sequence, LEAST(conversation.latest_message_sequence, combined.delivered_sequence)
), last_read_sequence = GREATEST(
member.last_read_sequence, LEAST(conversation.latest_message_sequence, combined.read_sequence)
) FROM combined
JOIN cloud_chat_conversations conversation ON conversation.conversation_id = combined.conversation_id
WHERE member.conversation_id = combined.conversation_id AND member.account_id = combined.account_id;
-- Any device that captured a v2 cursor before this backfill must bootstrap;
-- otherwise the retained history would exist without a corresponding event in
-- that already-observed stream. Advancing both head and retention floor by one
-- creates an explicit bootstrap boundary without manufacturing thousands of
-- historical transport events.
INSERT INTO cloud_chat_user_sync_heads (account_id, last_seq, min_seq)
SELECT DISTINCT member.account_id, 1, 1
FROM cloud_chat_conversation_members member
JOIN _chat_v2_legacy_conversation_map conversation
  ON conversation.conversation_id = member.conversation_id
ON CONFLICT (account_id) DO UPDATE
SET last_seq = cloud_chat_user_sync_heads.last_seq + 1,
    min_seq = cloud_chat_user_sync_heads.last_seq + 1;
SELECT pg_notify('chat_sync_events', 'legacy-v1-backfill-complete');
