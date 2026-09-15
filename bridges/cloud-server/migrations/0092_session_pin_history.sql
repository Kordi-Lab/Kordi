-- Pin state is mutable; these independently identified history events are not.
CREATE TABLE cloud_session_pin_history (
    event_id UUID PRIMARY KEY,
    sequence BIGSERIAL NOT NULL UNIQUE,
    occurred_at TIMESTAMPTZ NOT NULL,
    conversation_id UUID NOT NULL REFERENCES cloud_chat_conversations(conversation_id) ON DELETE CASCADE,
    actor_account_id TEXT NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    scope TEXT NOT NULL CHECK (scope IN ('private', 'shared')),
    payload JSONB NOT NULL
);
CREATE INDEX idx_session_pin_history_shared
    ON cloud_session_pin_history(conversation_id, sequence DESC) WHERE scope = 'shared';
CREATE INDEX idx_session_pin_history_private
    ON cloud_session_pin_history(conversation_id, actor_account_id, sequence DESC) WHERE scope = 'private';

CREATE INDEX idx_session_pin_history_time
    ON cloud_session_pin_history(conversation_id, occurred_at DESC, sequence DESC);

CREATE FUNCTION session_pin_history_time(value TEXT) RETURNS timestamptz LANGUAGE plpgsql AS $$
DECLARE parsed timestamptz;
BEGIN
    parsed := value::timestamptz;
    RETURN CASE WHEN isfinite(parsed) THEN parsed ELSE NULL END;
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
    RETURN NULL;
END;
$$;

-- Capture at the durable sync boundary so an older server replica still records
-- history during a rolling upgrade or rollback. Fanout copies share one ID.
CREATE FUNCTION record_session_pin_history() RETURNS trigger LANGUAGE plpgsql AS $$
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
    ELSE
    action_id := md5(jsonb_build_array(NEW.conversation_id, NEW.payload->>'sessionId',
        NEW.payload->>'scope', NEW.payload->>'updatedByAccountId', NEW.payload->>'updatedAt',
        NULLIF(NEW.payload->>'messageId', ''))::text)::uuid;
    END IF;
    action_payload := jsonb_build_object('id', action_id::text,
        'sessionId', NEW.payload->>'sessionId', 'scope', NEW.payload->>'scope',
        'kind', CASE WHEN NULLIF(NEW.payload->>'messageId', '') IS NULL THEN 'unpinned' ELSE 'pinned' END,
        'messageId', NULLIF(NEW.payload->>'messageId', ''),
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
CREATE TRIGGER record_session_pin_history
    BEFORE INSERT ON cloud_chat_user_sync_events
    FOR EACH ROW EXECUTE FUNCTION record_session_pin_history();
