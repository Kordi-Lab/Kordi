-- Normalize the existing message envelopes once, rather than decoding history on every badge refresh.
CREATE FUNCTION cloud_chat_attention_content(content JSONB) RETURNS JSONB
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE raw TEXT; encoded TEXT; envelope JSONB;
BEGIN
    SELECT b->>'text' INTO raw FROM jsonb_array_elements(COALESCE(content->'blocks','[]')) b
        WHERE b->>'type'='text' AND b->>'text'<>'' LIMIT 1;
    IF raw LIKE 'kordi-cloud-%:%' THEN
        encoded := split_part(raw, ':', 2);
        envelope := convert_from(decode(translate(encoded, '-_', '+/') || repeat('=', (4-length(encoded)%4)%4), 'base64'), 'UTF8')::JSONB;
        IF raw LIKE 'kordi-cloud-group:%' THEN
            IF envelope->>'kind' IS DISTINCT FROM 'group-message' THEN RETURN '{"hidden":true}'; END IF;
            RETURN (envelope->'message') - 'hidden';
        END IF;
        IF COALESCE(envelope->>'kind','') NOT IN ('message','agent-response') THEN RETURN '{"hidden":true}'; END IF;
        RETURN envelope - 'hidden';
    END IF;
    RETURN jsonb_build_object('text', COALESCE(raw,'')) || (content - 'blocks');
EXCEPTION WHEN OTHERS THEN RETURN '{"hidden":true}';
END $$;

ALTER TABLE cloud_chat_messages
    ADD COLUMN attention_content JSONB GENERATED ALWAYS AS (cloud_chat_attention_content(content)) STORED,
    ADD COLUMN thread_root_message_id UUID;

CREATE INDEX cloud_chat_message_client_lookup ON cloud_chat_messages(conversation_id,client_message_id);

CREATE FUNCTION cloud_chat_resolve_thread() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE data JSONB; reference TEXT; target UUID; explicit_thread BOOLEAN;
BEGIN
    data := cloud_chat_attention_content(NEW.content);
    explicit_thread := COALESCE(data#>>'{messageAction,kind}'='thread', false);
    reference := CASE WHEN explicit_thread THEN data#>>'{messageAction,source,sourceMessageId}'
        ELSE COALESCE(data->>'replyToMessageId', data->>'requestId', NEW.reply_to_message_id::TEXT) END;
    IF reference LIKE 'collaboration-message:%' THEN reference := substring(reference from '[0-9a-fA-F-]{36}$'); END IF;
    IF reference ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        SELECT CASE WHEN explicit_thread THEN COALESCE(m.thread_root_message_id,m.message_id) ELSE m.thread_root_message_id END INTO target
        FROM cloud_chat_messages m WHERE m.conversation_id=NEW.conversation_id
          AND (m.message_id=reference::UUID OR m.client_message_id=reference::UUID)
          AND m.message_id<>NEW.message_id ORDER BY (m.message_id=reference::UUID) DESC LIMIT 1;
    END IF;
    NEW.thread_root_message_id := target;
    RETURN NEW;
END $$;
CREATE TRIGGER cloud_chat_resolve_thread BEFORE INSERT OR UPDATE OF content, reply_to_message_id
    ON cloud_chat_messages FOR EACH ROW EXECUTE FUNCTION cloud_chat_resolve_thread();

-- Parents precede their replies in the canonical conversation sequence.
DO $$ DECLARE message RECORD;
BEGIN
    FOR message IN SELECT message_id FROM cloud_chat_messages ORDER BY conversation_id,conversation_sequence LOOP
        UPDATE cloud_chat_messages SET content=content WHERE message_id=message.message_id;
    END LOOP;
END $$;
CREATE INDEX cloud_chat_thread_messages ON cloud_chat_messages(conversation_id,thread_root_message_id,conversation_sequence)
    WHERE deleted_at IS NULL;
