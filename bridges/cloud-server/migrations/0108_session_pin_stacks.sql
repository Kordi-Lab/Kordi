-- Preserve existing pins and the legacy scalar projection during upgrades.
ALTER TABLE cloud_session_shared_pins ADD COLUMN message_ids TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE cloud_account_session_pins ADD COLUMN message_ids TEXT[] NOT NULL DEFAULT '{}';
UPDATE cloud_session_shared_pins SET message_ids = ARRAY[message_id];
UPDATE cloud_account_session_pins SET message_ids = ARRAY[message_id];

CREATE FUNCTION project_legacy_session_pin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF cardinality(NEW.message_ids) = 0 THEN NEW.message_ids := ARRAY[NEW.message_id]; END IF;
    ELSIF NEW.message_id IS DISTINCT FROM OLD.message_id AND NEW.message_ids IS NOT DISTINCT FROM OLD.message_ids THEN
        NEW.message_ids := ARRAY[NEW.message_id];
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER project_legacy_shared_pin BEFORE INSERT OR UPDATE ON cloud_session_shared_pins
    FOR EACH ROW EXECUTE FUNCTION project_legacy_session_pin();
CREATE TRIGGER project_legacy_private_pin BEFORE INSERT OR UPDATE ON cloud_account_session_pins
    FOR EACH ROW EXECUTE FUNCTION project_legacy_session_pin();
ALTER TABLE cloud_session_shared_pins ADD CONSTRAINT shared_pin_count CHECK (cardinality(message_ids) BETWEEN 1 AND 5);
ALTER TABLE cloud_account_session_pins ADD CONSTRAINT private_pin_count CHECK (cardinality(message_ids) BETWEEN 1 AND 5);

CREATE OR REPLACE FUNCTION record_session_pin_history() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    action_id UUID;
    action_payload JSONB;
    action_sequence BIGINT;
    action_time TIMESTAMPTZ;
BEGIN
    IF NEW.event_type <> 'session.pin.updated' OR NEW.conversation_id IS NULL
       OR COALESCE(NEW.payload->>'scope', '') NOT IN ('private', 'shared')
       OR COALESCE(NEW.payload->>'sessionId', '') = ''
       OR COALESCE(NEW.payload->>'updatedByAccountId', '') = ''
       OR COALESCE(NEW.payload->>'updatedAt', '') = '' THEN
        RETURN NEW;
    END IF;
    action_time := session_pin_history_time(NEW.payload->>'updatedAt');
    IF action_time IS NULL THEN RETURN NEW; END IF;
    IF COALESCE(NEW.payload->>'pinHistoryId', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        action_id := (NEW.payload->>'pinHistoryId')::uuid;
    ELSIF NEW.payload ? 'targetMessageId' THEN
        action_id := md5(jsonb_build_array(NEW.conversation_id, NEW.payload->>'sessionId',
            NEW.payload->>'scope', NEW.payload->>'updatedByAccountId', NEW.payload->>'updatedAt',
            NULLIF(NEW.payload->>'messageId', ''), NEW.payload->>'kind', NEW.payload->>'targetMessageId')::text)::uuid;
    ELSE
        action_id := md5(jsonb_build_array(NEW.conversation_id, NEW.payload->>'sessionId',
            NEW.payload->>'scope', NEW.payload->>'updatedByAccountId', NEW.payload->>'updatedAt',
            NULLIF(NEW.payload->>'messageId', ''))::text)::uuid;
    END IF;
    action_payload := jsonb_build_object('id', action_id::text,
        'sessionId', NEW.payload->>'sessionId', 'scope', NEW.payload->>'scope',
        'kind', CASE WHEN NEW.payload->>'kind' IN ('pinned', 'unpinned') THEN NEW.payload->>'kind'
            WHEN NULLIF(NEW.payload->>'messageId', '') IS NULL THEN 'unpinned' ELSE 'pinned' END,
        'messageId', CASE WHEN NEW.payload ? 'targetMessageId' THEN NULLIF(NEW.payload->>'targetMessageId', '')
            ELSE NULLIF(NEW.payload->>'messageId', '') END,
        'updatedByAccountId', NEW.payload->>'updatedByAccountId', 'updatedAt', NEW.payload->>'updatedAt');
    INSERT INTO cloud_session_pin_history(event_id, occurred_at, conversation_id, actor_account_id, scope, payload)
    VALUES (action_id, action_time, NEW.conversation_id, NEW.payload->>'updatedByAccountId', NEW.payload->>'scope', action_payload)
    ON CONFLICT (event_id) DO NOTHING;
    SELECT sequence, payload INTO action_sequence, action_payload FROM cloud_session_pin_history WHERE event_id = action_id;
    IF NOT (action_payload ? 'sequence') THEN
        action_payload := action_payload || jsonb_build_object('sequence', action_sequence);
        UPDATE cloud_session_pin_history SET payload = action_payload WHERE event_id = action_id;
    END IF;
    NEW.payload := NEW.payload || jsonb_build_object('pinHistoryEvent', action_payload);
    RETURN NEW;
END;
$$;
