-- Contact consent and blocks.
--
-- A `cloud_contacts(account_id=A, peer_account_id=B)` row means "A accepted
-- B". Two accounts are contacts only when both rows exist and neither has
-- blocked the other. Rows are created and removed in pairs from now on; a
-- one-way row grants nothing. This migration converts the one-way rows that
-- already exist and records every change in `cloud_contact_consent_backfill`
-- so the conversion can be reverted with
-- `cloud_revert_contact_consent_backfill()`.
--
-- All SQL function parameters use a `p_` prefix because column names take
-- precedence over parameter names inside SQL functions.

CREATE TABLE IF NOT EXISTS cloud_account_blocks (
    blocker_account_id TEXT NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    blocked_account_id TEXT NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (blocker_account_id, blocked_account_id),
    CHECK (blocker_account_id <> blocked_account_id)
);

CREATE INDEX IF NOT EXISTS idx_cloud_account_blocks_blocked
    ON cloud_account_blocks (blocked_account_id, blocker_account_id);

-- The original status CHECK from 0003 is unnamed. Drop it by definition and
-- keep the from <> to CHECK, then allow a sender to withdraw a request.
DO $$
DECLARE
    constraint_name TEXT;
BEGIN
    FOR constraint_name IN
        SELECT conname FROM pg_constraint
        WHERE conrelid = 'cloud_contact_requests'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ILIKE '%status%'
    LOOP
        EXECUTE format('ALTER TABLE cloud_contact_requests DROP CONSTRAINT %I', constraint_name);
    END LOOP;
END $$;

ALTER TABLE cloud_contact_requests ADD CONSTRAINT cloud_contact_requests_status_check
    CHECK (status IN ('pending', 'accepted', 'rejected', 'withdrawn'));

CREATE OR REPLACE FUNCTION cloud_accounts_blocked_either_way(p_a TEXT, p_b TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1 FROM cloud_account_blocks x
        WHERE (x.blocker_account_id = p_a AND x.blocked_account_id = p_b)
           OR (x.blocker_account_id = p_b AND x.blocked_account_id = p_a))
$$;

CREATE OR REPLACE FUNCTION cloud_accounts_are_contacts(p_a TEXT, p_b TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
    SELECT p_a <> p_b
       AND EXISTS (SELECT 1 FROM cloud_contacts c
                   WHERE c.account_id = p_a AND c.peer_account_id = p_b)
       AND EXISTS (SELECT 1 FROM cloud_contacts c
                   WHERE c.account_id = p_b AND c.peer_account_id = p_a)
       AND NOT cloud_accounts_blocked_either_way(p_a, p_b)
$$;

-- Service accounts (PiP, Kordi Support) own a system-managed agent.
CREATE OR REPLACE FUNCTION cloud_account_is_service(p_account TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1 FROM cloud_agent_definitions d
        WHERE d.owner_account_id = p_account AND d.is_system_managed)
$$;

-- A requester may use an owner's default agent only as a mutual contact, and
-- an agent the owner shared with conversation participants unless either
-- account blocked the other.
CREATE OR REPLACE FUNCTION cloud_requester_may_use_agent(p_requester TEXT, p_owner TEXT, p_agent TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
    SELECT p_requester = p_owner
        OR (NOT cloud_accounts_blocked_either_way(p_requester, p_owner)
            AND (((p_agent = 'cloud-agent:' || p_owner OR p_agent = 'cloud-self:' || p_owner)
                  AND cloud_accounts_are_contacts(p_requester, p_owner))
                 OR EXISTS (SELECT 1 FROM cloud_agent_definitions d
                            WHERE d.agent_id = p_agent
                              AND d.owner_account_id = p_owner
                              AND d.status = 'active'
                              AND d.access_scope = 'participant_conversations')))
$$;

-- Whether `p_sender` wrote a message of their own to `p_other` in a person
-- DM. Agent output and imported history do not count.
CREATE OR REPLACE FUNCTION cloud_account_wrote_in_direct_chat(p_sender TEXT, p_other TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1
        FROM cloud_chat_conversations conversation
        JOIN cloud_chat_conversation_members sender
          ON sender.conversation_id = conversation.conversation_id
         AND sender.account_id = p_sender
        JOIN cloud_chat_conversation_members other
          ON other.conversation_id = conversation.conversation_id
         AND other.account_id = p_other
        JOIN cloud_chat_messages message
          ON message.conversation_id = conversation.conversation_id
        WHERE conversation.kind = 'direct'
          AND conversation.legacy_session_id LIKE 'session:direct-person:%'
          AND message.sender_account_id = p_sender
          AND message.deleted_at IS NULL
          AND message.message_kind <> 'assistant'
          AND message.message_kind NOT LIKE 'canonical-history-%'
          AND ltrim(COALESCE(message.content #>> '{blocks,0,text}', ''))
              NOT LIKE 'kordi-cloud-agent-response:%')
$$;

-- One row per converted one-way contact row. It keeps the original row and
-- every request the conversion created or decided, so an operator can revert.
CREATE TABLE IF NOT EXISTS cloud_contact_consent_backfill (
    backfill_id          BIGSERIAL PRIMARY KEY,
    account_id           TEXT NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    peer_account_id      TEXT NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    original_created_at  TEXT NOT NULL,
    outcome              TEXT NOT NULL CHECK (outcome IN (
                             'dropped_self', 'dropped_service', 'completed_by_peer_consent',
                             'kept_pending_request', 'dropped_after_decline', 'dropped_blocked',
                             'converted_to_request')),
    request_id           TEXT,
    accepted_request_ids TEXT[] NOT NULL DEFAULT '{}',
    recorded_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    reverted_at          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_cloud_contact_consent_backfill_pair
    ON cloud_contact_consent_backfill (account_id, peer_account_id);

-- Converts every one-way contact row. Idempotent: a converted row no longer
-- qualifies, so a second run changes nothing. Operators re-run it after a
-- rolling deploy if an older replica wrote new one-way rows. It never touches
-- messages, conversations, or memberships, and sends no notifications.
CREATE OR REPLACE FUNCTION cloud_convert_one_way_contacts() RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
    row_to_convert RECORD;
    now_text TEXT := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"');
    processed INTEGER := 0;
    blocked BOOLEAN;
    consented BOOLEAN;
    accepted_ids TEXT[];
    pending_id TEXT;
    latest_status TEXT;
    outcome_value TEXT;
    request_value TEXT;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('kordi-contact-consent-backfill', 0));
    FOR row_to_convert IN
        SELECT c.account_id, c.peer_account_id, c.created_at
        FROM cloud_contacts c
        WHERE c.account_id = c.peer_account_id
           OR NOT EXISTS (SELECT 1 FROM cloud_contacts r
                          WHERE r.account_id = c.peer_account_id
                            AND r.peer_account_id = c.account_id)
        ORDER BY c.account_id, c.peer_account_id
        FOR UPDATE
    LOOP
        request_value := NULL;
        accepted_ids := '{}';
        IF row_to_convert.account_id = row_to_convert.peer_account_id THEN
            outcome_value := 'dropped_self';
        ELSIF cloud_account_is_service(row_to_convert.account_id)
           OR cloud_account_is_service(row_to_convert.peer_account_id) THEN
            outcome_value := 'dropped_service';
        ELSE
            blocked := cloud_accounts_blocked_either_way(
                row_to_convert.account_id, row_to_convert.peer_account_id);
            consented := FALSE;
            IF NOT blocked THEN
                -- The peer consented through an accepted request, a pending
                -- request of its own, or by writing in a person DM.
                SELECT EXISTS (
                    SELECT 1 FROM cloud_contact_requests q
                    WHERE q.status = 'accepted'
                      AND ((q.from_account_id = row_to_convert.account_id
                            AND q.to_account_id = row_to_convert.peer_account_id)
                        OR (q.from_account_id = row_to_convert.peer_account_id
                            AND q.to_account_id = row_to_convert.account_id)))
                INTO consented;
                IF NOT consented THEN
                    consented := EXISTS (
                        SELECT 1 FROM cloud_contact_requests q
                        WHERE q.status = 'pending'
                          AND q.from_account_id = row_to_convert.peer_account_id
                          AND q.to_account_id = row_to_convert.account_id);
                END IF;
                IF NOT consented THEN
                    consented := cloud_account_wrote_in_direct_chat(
                        row_to_convert.peer_account_id, row_to_convert.account_id);
                END IF;
            END IF;

            IF consented THEN
                outcome_value := 'completed_by_peer_consent';
                WITH decided AS (
                    UPDATE cloud_contact_requests q
                    SET status = 'accepted', decided_at = now_text
                    WHERE q.status = 'pending'
                      AND ((q.from_account_id = row_to_convert.account_id
                            AND q.to_account_id = row_to_convert.peer_account_id)
                        OR (q.from_account_id = row_to_convert.peer_account_id
                            AND q.to_account_id = row_to_convert.account_id))
                    RETURNING q.request_id)
                SELECT COALESCE(array_agg(request_id ORDER BY request_id), '{}')
                INTO accepted_ids FROM decided;
                INSERT INTO cloud_contacts (account_id, peer_account_id, created_at)
                VALUES (row_to_convert.peer_account_id, row_to_convert.account_id,
                        row_to_convert.created_at)
                ON CONFLICT (account_id, peer_account_id) DO NOTHING;
            ELSE
                SELECT q.request_id INTO pending_id
                FROM cloud_contact_requests q
                WHERE q.status = 'pending'
                  AND q.from_account_id = row_to_convert.account_id
                  AND q.to_account_id = row_to_convert.peer_account_id;
                SELECT q.status INTO latest_status
                FROM cloud_contact_requests q
                WHERE q.from_account_id = row_to_convert.account_id
                  AND q.to_account_id = row_to_convert.peer_account_id
                ORDER BY q.created_at DESC, q.request_id DESC
                LIMIT 1;
                IF pending_id IS NOT NULL THEN
                    outcome_value := 'kept_pending_request';
                    request_value := pending_id;
                ELSIF latest_status IN ('rejected', 'withdrawn') THEN
                    outcome_value := 'dropped_after_decline';
                ELSIF blocked THEN
                    outcome_value := 'dropped_blocked';
                ELSE
                    outcome_value := 'converted_to_request';
                    INSERT INTO cloud_contact_requests
                        (request_id, from_account_id, to_account_id, status, message, created_at)
                    VALUES ('req_' || replace(gen_random_uuid()::TEXT, '-', ''),
                            row_to_convert.account_id, row_to_convert.peer_account_id,
                            'pending', NULL, row_to_convert.created_at)
                    ON CONFLICT DO NOTHING
                    RETURNING request_id INTO request_value;
                    IF request_value IS NULL THEN
                        -- A request written concurrently already covers the pair.
                        outcome_value := 'kept_pending_request';
                        SELECT q.request_id INTO request_value
                        FROM cloud_contact_requests q
                        WHERE q.status = 'pending'
                          AND q.from_account_id = row_to_convert.account_id
                          AND q.to_account_id = row_to_convert.peer_account_id;
                    END IF;
                END IF;
            END IF;
        END IF;

        IF outcome_value <> 'completed_by_peer_consent' THEN
            DELETE FROM cloud_contacts
            WHERE account_id = row_to_convert.account_id
              AND peer_account_id = row_to_convert.peer_account_id;
        END IF;
        INSERT INTO cloud_contact_consent_backfill
            (account_id, peer_account_id, original_created_at, outcome, request_id,
             accepted_request_ids)
        VALUES (row_to_convert.account_id, row_to_convert.peer_account_id,
                row_to_convert.created_at, outcome_value, request_value, accepted_ids);
        processed := processed + 1;
    END LOOP;
    RETURN processed;
END $$;

-- Operator-only undo for a product rollback: restores every converted
-- one-way row, removes the reverse rows and pending requests the conversion
-- created, and reopens the requests it accepted when no other request is
-- pending for that pair. Rows are marked reverted, so a second run is a no-op.
CREATE OR REPLACE FUNCTION cloud_revert_contact_consent_backfill() RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
    entry RECORD;
    reverted INTEGER := 0;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('kordi-contact-consent-backfill', 0));
    FOR entry IN
        SELECT * FROM cloud_contact_consent_backfill
        WHERE reverted_at IS NULL
        ORDER BY backfill_id DESC
        FOR UPDATE
    LOOP
        IF entry.outcome = 'completed_by_peer_consent' THEN
            DELETE FROM cloud_contacts
            WHERE account_id = entry.peer_account_id
              AND peer_account_id = entry.account_id
              AND created_at = entry.original_created_at;
            UPDATE cloud_contact_requests q
            SET status = 'pending', decided_at = NULL
            WHERE q.request_id = ANY (entry.accepted_request_ids)
              AND q.status = 'accepted'
              AND NOT EXISTS (
                  SELECT 1 FROM cloud_contact_requests p
                  WHERE p.from_account_id = q.from_account_id
                    AND p.to_account_id = q.to_account_id
                    AND p.status = 'pending');
        ELSE
            INSERT INTO cloud_contacts (account_id, peer_account_id, created_at)
            VALUES (entry.account_id, entry.peer_account_id, entry.original_created_at)
            ON CONFLICT (account_id, peer_account_id) DO NOTHING;
            IF entry.outcome = 'converted_to_request' THEN
                DELETE FROM cloud_contact_requests
                WHERE request_id = entry.request_id AND status = 'pending';
            END IF;
        END IF;
        UPDATE cloud_contact_consent_backfill SET reverted_at = now()
        WHERE backfill_id = entry.backfill_id;
        reverted := reverted + 1;
    END LOOP;
    RETURN reverted;
END $$;

-- Operator-only cleanup of the archive. Nothing runs it automatically: the
-- archive is the only way to revert the conversion, so it is kept until an
-- operator decides otherwise. By default it only counts the rows recorded
-- more than `p_older_than` ago (at least 90 days); `p_apply => true` deletes
-- them, after which those rows can no longer be reverted.
CREATE OR REPLACE FUNCTION cloud_purge_contact_consent_backfill(
    p_older_than INTERVAL,
    p_apply BOOLEAN DEFAULT FALSE
) RETURNS BIGINT
LANGUAGE plpgsql AS $$
DECLARE
    affected BIGINT;
BEGIN
    IF p_older_than IS NULL OR p_older_than < INTERVAL '90 days' THEN
        RAISE EXCEPTION 'contact conversion archive rows are kept for at least 90 days';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('kordi-contact-consent-backfill', 0));
    IF p_apply THEN
        DELETE FROM cloud_contact_consent_backfill
        WHERE recorded_at < now() - p_older_than;
        GET DIAGNOSTICS affected = ROW_COUNT;
    ELSE
        SELECT count(*) INTO affected FROM cloud_contact_consent_backfill
        WHERE recorded_at < now() - p_older_than;
    END IF;
    RETURN affected;
END $$;

SELECT cloud_convert_one_way_contacts();
