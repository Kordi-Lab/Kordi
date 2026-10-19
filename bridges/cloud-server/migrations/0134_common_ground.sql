-- Common ground: interest cards, event rooms joined by a short code, and
-- one-to-one pairings. A card is visible only to its owner and to people who
-- share an open room or a pairing with them; hidden topics and references
-- never leave the owner. Deleting an account removes everything here.

CREATE TABLE IF NOT EXISTS cloud_common_ground_cards (
    account_id       TEXT PRIMARY KEY REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    -- {workingOn, interests, canHelp, lookingFor, earlier: [label],
    --  refs: {label: [evidence id]}}
    topics_json      JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- [{id, source, title, date, url, snippet}]: only evidence the card cites.
    evidence_json    JSONB NOT NULL DEFAULT '[]'::jsonb,
    hidden_json      JSONB NOT NULL DEFAULT '[]'::jsonb,
    sharing_enabled  BOOLEAN NOT NULL DEFAULT TRUE,
    revision         BIGINT NOT NULL DEFAULT 0,
    -- The card build in flight, if any, and the reason the last one failed.
    -- `build_evidence_json` holds the redacted evidence the run was given
    -- until it finishes, so the reply's citations can be resolved.
    active_run_id       TEXT,
    build_started_at    TIMESTAMPTZ,
    build_evidence_json JSONB,
    build_error_code    TEXT,
    built_at         TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_common_ground_cards_active_run
    ON cloud_common_ground_cards (active_run_id)
    WHERE active_run_id IS NOT NULL;

-- A code names at most one open room. A room closes 24 hours after its last
-- join; the next person to enter that code opens a new room.
CREATE TABLE IF NOT EXISTS cloud_common_ground_rooms (
    room_id      UUID PRIMARY KEY,
    code         TEXT NOT NULL CHECK (code ~ '^[0-9]{4}$'),
    name         TEXT NOT NULL DEFAULT '' CHECK (char_length(name) <= 80),
    created_by   TEXT REFERENCES cloud_accounts(account_id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_join_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_at    TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_common_ground_rooms_open_code
    ON cloud_common_ground_rooms (code)
    WHERE closed_at IS NULL;

CREATE TABLE IF NOT EXISTS cloud_common_ground_room_members (
    room_id    UUID NOT NULL REFERENCES cloud_common_ground_rooms(room_id) ON DELETE CASCADE,
    account_id TEXT NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    joined_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    left_at    TIMESTAMPTZ,
    PRIMARY KEY (room_id, account_id)
);

CREATE INDEX IF NOT EXISTS idx_cloud_common_ground_room_members_account
    ON cloud_common_ground_room_members (account_id)
    WHERE left_at IS NULL;

-- Pairing codes are stored hashed, last 2 minutes and work once.
CREATE TABLE IF NOT EXISTS cloud_common_ground_pairing_codes (
    code_hash   TEXT PRIMARY KEY,
    account_id  TEXT NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL,
    redeemed_at TIMESTAMPTZ,
    redeemed_by TEXT REFERENCES cloud_accounts(account_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_cloud_common_ground_pairing_codes_account
    ON cloud_common_ground_pairing_codes (account_id, created_at DESC);

-- One row per pair of people, stored with the smaller account id first.
CREATE TABLE IF NOT EXISTS cloud_common_ground_pairings (
    account_a  TEXT NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    account_b  TEXT NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (account_a, account_b),
    CHECK (account_a < account_b)
);

CREATE INDEX IF NOT EXISTS idx_cloud_common_ground_pairings_b
    ON cloud_common_ground_pairings (account_b);

-- Match results as the viewer sees them, valid for the two card revisions
-- they were computed from. `opened_at` orders the viewer's Recent list.
CREATE TABLE IF NOT EXISTS cloud_common_ground_matches (
    viewer_account_id TEXT NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    other_account_id  TEXT NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    viewer_revision   BIGINT NOT NULL,
    other_revision    BIGINT NOT NULL,
    result_json       JSONB NOT NULL,
    computed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    opened_at         TIMESTAMPTZ,
    PRIMARY KEY (viewer_account_id, other_account_id),
    CHECK (viewer_account_id <> other_account_id)
);

CREATE INDEX IF NOT EXISTS idx_cloud_common_ground_matches_recent
    ON cloud_common_ground_matches (viewer_account_id, opened_at DESC)
    WHERE opened_at IS NOT NULL;
