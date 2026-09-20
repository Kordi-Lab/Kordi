-- Durable plan-card calendar projection and PiP's immutable post-join context boundary.
CREATE TABLE IF NOT EXISTS cloud_plan_card_projection_queue (
    event_id          TEXT PRIMARY KEY
        REFERENCES cloud_plan_cards (event_id) ON DELETE CASCADE,
    target_revision   BIGINT NOT NULL CHECK (target_revision >= 1),
    attempts          INTEGER NOT NULL DEFAULT 0,
    retry_after       TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_error        TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cloud_plan_card_projection_queue_due
    ON cloud_plan_card_projection_queue (retry_after, updated_at);

INSERT INTO cloud_plan_card_projection_queue (event_id, target_revision)
SELECT event_id, revision FROM cloud_plan_cards
ON CONFLICT (event_id) DO UPDATE SET
    target_revision = GREATEST(
        cloud_plan_card_projection_queue.target_revision,
        EXCLUDED.target_revision
    ),
    retry_after = now(),
    updated_at = now();

CREATE OR REPLACE FUNCTION cloud_plan_card_enqueue_projection()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    INSERT INTO cloud_plan_card_projection_queue (event_id, target_revision)
    VALUES (NEW.event_id, NEW.revision)
    ON CONFLICT (event_id) DO UPDATE SET
        target_revision = EXCLUDED.target_revision,
        attempts = 0,
        retry_after = now(),
        last_error = NULL,
        updated_at = now()
    WHERE cloud_plan_card_projection_queue.target_revision < EXCLUDED.target_revision;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS cloud_plan_card_enqueue_projection ON cloud_plan_cards;
CREATE TRIGGER cloud_plan_card_enqueue_projection
AFTER INSERT OR UPDATE OF revision ON cloud_plan_cards
FOR EACH ROW EXECUTE FUNCTION cloud_plan_card_enqueue_projection();

ALTER TABLE cloud_pip_conversation_state
    ADD COLUMN IF NOT EXISTS context_start_sequence BIGINT NOT NULL DEFAULT 0;

UPDATE cloud_pip_conversation_state
SET context_start_sequence = seen_sequence
WHERE context_start_sequence = 0;

CREATE OR REPLACE FUNCTION cloud_pip_seed_context_start_sequence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.context_start_sequence = 0 THEN
        NEW.context_start_sequence := NEW.seen_sequence;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS cloud_pip_seed_context_start_sequence ON cloud_pip_conversation_state;
CREATE TRIGGER cloud_pip_seed_context_start_sequence
BEFORE INSERT ON cloud_pip_conversation_state
FOR EACH ROW EXECUTE FUNCTION cloud_pip_seed_context_start_sequence();
