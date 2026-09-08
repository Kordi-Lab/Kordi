-- Historical direct IDs can still own real messages and references. Preserve
-- them, while enforcing the canonical shape on new or changed identities.
CREATE FUNCTION enforce_direct_session_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.kind IS NOT DISTINCT FROM OLD.kind
       AND NEW.legacy_session_id IS NOT DISTINCT FROM OLD.legacy_session_id THEN
        RETURN NEW;
    END IF;
    IF NEW.kind = 'direct' AND NOT COALESCE(
        NEW.legacy_session_id LIKE 'session:direct-person:%'
        OR NEW.legacy_session_id LIKE 'session:direct-agent:%'
        OR NEW.legacy_session_id LIKE 'session:direct-system-agent:%', FALSE) THEN
        RAISE EXCEPTION 'direct conversation session id is invalid'
            USING ERRCODE = '23514', CONSTRAINT = 'cloud_chat_direct_session_identity';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER cloud_chat_direct_session_identity
    BEFORE INSERT OR UPDATE OF kind, legacy_session_id ON cloud_chat_conversations
    FOR EACH ROW EXECUTE FUNCTION enforce_direct_session_identity();
