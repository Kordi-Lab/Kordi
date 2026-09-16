-- Shared, stateful plan cards for group-chat coordination (issue #1546).
-- A conversation may hold more than one open card at once (e.g. "lunch this
-- week" and a separate trip); there is deliberately no uniqueness constraint
-- forcing a single open card per conversation. The tool layer decides
-- create-vs-update via existingEventId/existingRevision on propose.
CREATE TABLE cloud_plan_cards (
    event_id                TEXT PRIMARY KEY,
    conversation_id         UUID NOT NULL
                            REFERENCES cloud_chat_conversations(conversation_id)
                            ON DELETE CASCADE,
    state                   TEXT NOT NULL
                            CHECK (state IN ('polling', 'awaiting_confirmation', 'confirmed', 'canceled')),
    title                   TEXT NOT NULL,
    start_at                TIMESTAMPTZ,
    end_at                  TIMESTAMPTZ,
    location                TEXT,
    unresolved_fields       JSONB NOT NULL DEFAULT '[]',
    source_message_ids      JSONB NOT NULL DEFAULT '[]',
    note                    TEXT,
    revision                BIGINT NOT NULL DEFAULT 1 CHECK (revision >= 1),
    created_by_account_id   TEXT NOT NULL REFERENCES cloud_accounts(account_id),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (end_at IS NULL OR start_at IS NULL OR end_at >= start_at)
);

CREATE INDEX idx_cloud_plan_cards_conversation
    ON cloud_plan_cards(conversation_id, updated_at DESC);

-- Per-participant RSVP is tracked separately from the card's top-level
-- `state`: rsvp writes never touch `state`, which is what makes "a single
-- non-organizer decline never cancels the plan" a structural fact rather
-- than an application rule that could be forgotten in one code path.
CREATE TABLE cloud_plan_card_participants (
    event_id        TEXT NOT NULL
                    REFERENCES cloud_plan_cards(event_id) ON DELETE CASCADE,
    account_id      TEXT NOT NULL
                    REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    display_name    TEXT NOT NULL,
    organizer       BOOLEAN NOT NULL DEFAULT false,
    rsvp            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (rsvp IN ('pending', 'yes', 'no')),
    responded_at    TIMESTAMPTZ,
    PRIMARY KEY (event_id, account_id)
);

CREATE INDEX idx_cloud_plan_card_participants_by_account
    ON cloud_plan_card_participants(account_id, event_id);
