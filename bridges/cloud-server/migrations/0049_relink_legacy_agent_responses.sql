-- Repair causality links inside direct-agent envelopes migrated by 0048.
--
-- The v1 response body referenced cloud_messages.message_id. Migration 0048
-- assigned a canonical UUID to that request but deliberately retained the
-- original body byte-for-byte. A v2-only client therefore saw a terminal
-- response whose requestId could never equal the canonical request UUID and
-- rendered the request as permanently processing.
--
-- Decode defensively because retained message bodies are user-controlled. A
-- malformed legacy envelope must be skipped instead of aborting startup.
CREATE OR REPLACE FUNCTION pg_temp.chat_v2_decode_base64url_json(payload TEXT)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN convert_from(
        decode(
            rpad(
                translate(payload, '-_', '+/'),
                ((length(payload) + 3) / 4) * 4,
                '='
            ),
            'base64'
        ),
        'UTF8'
    )::jsonb;
EXCEPTION
    WHEN OTHERS THEN
        RETURN NULL;
END;
$$;

CREATE TEMP TABLE _chat_v2_legacy_agent_response_links ON COMMIT DROP AS
WITH encoded AS (
    SELECT legacy.message_id AS legacy_response_id,
           CASE
               WHEN legacy.body LIKE 'kordi-cloud-agent-response:%'
                   THEN 'kordi-cloud-agent-response:'
               WHEN legacy.body LIKE 'kordi-cloud-agent-cancel:%'
                   THEN 'kordi-cloud-agent-cancel:'
               ELSE NULL
           END AS prefix,
           legacy.body
    FROM cloud_messages legacy
    WHERE legacy.body LIKE 'kordi-cloud-agent-response:%'
       OR legacy.body LIKE 'kordi-cloud-agent-cancel:%'
), decoded AS (
    SELECT encoded.*,
           pg_temp.chat_v2_decode_base64url_json(
               substring(encoded.body FROM length(encoded.prefix) + 1)
           ) AS envelope
    FROM encoded
), linked AS (
    SELECT response_map.canonical_message_id AS response_message_id,
           request_map.canonical_message_id AS request_message_id,
           decoded.prefix,
           decoded.envelope
    FROM decoded
    JOIN cloud_chat_legacy_message_map response_map
      ON response_map.legacy_message_id = decoded.legacy_response_id
    JOIN cloud_chat_legacy_message_map request_map
      ON request_map.legacy_message_id = decoded.envelope->>'requestId'
    JOIN cloud_chat_messages response_message
      ON response_message.message_id = response_map.canonical_message_id
    JOIN cloud_chat_messages request_message
      ON request_message.message_id = request_map.canonical_message_id
     AND request_message.conversation_id = response_message.conversation_id
    WHERE decoded.envelope IS NOT NULL
      AND NULLIF(btrim(decoded.envelope->>'requestId'), '') IS NOT NULL
)
SELECT DISTINCT ON (response_message_id)
       response_message_id,
       request_message_id,
       prefix || rtrim(
           translate(
               replace(
                   encode(
                       convert_to(
                           jsonb_set(
                               envelope,
                               '{requestId}',
                               to_jsonb(request_message_id::text),
                               true
                           )::text,
                           'UTF8'
                       ),
                       'base64'
                   ),
                   E'\n',
                   ''
               ),
               '+/',
               '-_'
           ),
           '='
       ) AS canonical_body
FROM linked
ORDER BY response_message_id, request_message_id;

DELETE FROM _chat_v2_legacy_agent_response_links candidate
USING cloud_chat_messages response
WHERE response.message_id = candidate.response_message_id
  AND response.reply_to_message_id = candidate.request_message_id
  AND response.content #>> '{blocks,0,text}' = candidate.canonical_body;

UPDATE cloud_chat_messages response
SET content = jsonb_set(
        response.content,
        '{blocks,0,text}',
        to_jsonb(candidate.canonical_body),
        false
    ),
    reply_to_message_id = candidate.request_message_id,
    version = response.version + 1
FROM _chat_v2_legacy_agent_response_links candidate
WHERE response.message_id = candidate.response_message_id;

-- Existing devices may already have the version-1 response in SQLite. Move
-- only affected users across an explicit retention boundary so their next
-- incremental request receives SYNC_CURSOR_EXPIRED and atomically bootstraps
-- the corrected snapshots. This is the same safe boundary used by 0048.
WITH affected_accounts AS (
    SELECT DISTINCT member.account_id
    FROM _chat_v2_legacy_agent_response_links candidate
    JOIN cloud_chat_messages response
      ON response.message_id = candidate.response_message_id
    JOIN cloud_chat_conversation_members member
      ON member.conversation_id = response.conversation_id
     AND member.membership_state = 'active'
)
INSERT INTO cloud_chat_user_sync_heads (account_id, last_seq, min_seq)
SELECT account_id, 1, 1
FROM affected_accounts
ON CONFLICT (account_id) DO UPDATE
SET last_seq = cloud_chat_user_sync_heads.last_seq + 1,
    min_seq = cloud_chat_user_sync_heads.last_seq + 1;

SELECT pg_notify('chat_sync_events', 'legacy-agent-response-links-repaired');
