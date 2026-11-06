-- Push session revocations to open realtime sockets.
--
-- Long-lived sockets (chat realtime, document collaboration) used to poll
-- PostgreSQL every few seconds to notice sign-out and device revocation.
-- These triggers publish a notification on `cloud_session_signals` when a
-- session or device is revoked or deleted, or when the account facts that
-- instance admission depends on change. Each server replica holds one
-- listener connection and routes the signal to the affected sockets, so a
-- revocation reaches them as soon as its transaction commits, from any code
-- path and any replica. Sockets still recheck periodically in case a
-- notification is lost while a listener reconnects.
--
-- Payload: {"a": account_id, "d": device_id | null, "t": token_id | null,
--           "k": "revoked" | "recheck"}

CREATE OR REPLACE FUNCTION cloud_notify_session_signal(
    account_id TEXT,
    device_id TEXT,
    token_id TEXT,
    kind TEXT
) RETURNS void AS $$
BEGIN
    PERFORM pg_notify(
        'cloud_session_signals',
        json_build_object('a', account_id, 'd', device_id, 't', token_id, 'k', kind)::text
    );
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION cloud_refresh_tokens_signal_revocation() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.revoked_at IS NULL THEN
            PERFORM cloud_notify_session_signal(OLD.account_id, OLD.device_id, OLD.token_id, 'revoked');
        END IF;
        RETURN OLD;
    END IF;
    IF NEW.revoked_at IS NOT NULL AND OLD.revoked_at IS NULL THEN
        PERFORM cloud_notify_session_signal(NEW.account_id, NEW.device_id, NEW.token_id, 'revoked');
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS cloud_refresh_tokens_signal_revocation ON cloud_refresh_tokens;
CREATE TRIGGER cloud_refresh_tokens_signal_revocation
    AFTER UPDATE OF revoked_at OR DELETE ON cloud_refresh_tokens
    FOR EACH ROW EXECUTE FUNCTION cloud_refresh_tokens_signal_revocation();

CREATE OR REPLACE FUNCTION cloud_devices_signal_revocation() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.revoked_at IS NULL THEN
            PERFORM cloud_notify_session_signal(OLD.account_id, OLD.device_id, NULL, 'revoked');
        END IF;
        RETURN OLD;
    END IF;
    IF NEW.revoked_at IS NOT NULL AND OLD.revoked_at IS NULL THEN
        PERFORM cloud_notify_session_signal(NEW.account_id, NEW.device_id, NULL, 'revoked');
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS cloud_devices_signal_revocation ON cloud_devices;
CREATE TRIGGER cloud_devices_signal_revocation
    AFTER UPDATE OF revoked_at OR DELETE ON cloud_devices
    FOR EACH ROW EXECUTE FUNCTION cloud_devices_signal_revocation();

CREATE OR REPLACE FUNCTION cloud_accounts_signal_session_change() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        PERFORM cloud_notify_session_signal(OLD.account_id, NULL, NULL, 'revoked');
        RETURN OLD;
    END IF;
    IF NEW.primary_email IS DISTINCT FROM OLD.primary_email
        OR NEW.primary_email_verified_at IS DISTINCT FROM OLD.primary_email_verified_at THEN
        PERFORM cloud_notify_session_signal(NEW.account_id, NULL, NULL, 'recheck');
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS cloud_accounts_signal_session_change ON cloud_accounts;
CREATE TRIGGER cloud_accounts_signal_session_change
    AFTER UPDATE OF primary_email, primary_email_verified_at OR DELETE ON cloud_accounts
    FOR EACH ROW EXECUTE FUNCTION cloud_accounts_signal_session_change();
