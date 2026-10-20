-- Common ground matching: background runs that match a viewer with other
-- people, and the topic themes of a room.

-- One row per matching run. `cards_json` holds the shared cards the run was
-- given, with their revisions, so the reply is checked against exactly what
-- the run read and stored only while those revisions are current.
CREATE TABLE IF NOT EXISTS cloud_common_ground_match_runs (
    run_id            TEXT PRIMARY KEY,
    kind              TEXT NOT NULL CHECK (kind IN ('match', 'room')),
    viewer_account_id TEXT REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    room_id           UUID REFERENCES cloud_common_ground_rooms(room_id) ON DELETE CASCADE,
    -- [{accountId, name, revision, topics}] in prompt order; for a match run
    -- the viewer's card comes first.
    cards_json        JSONB NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at       TIMESTAMPTZ,
    error_code        TEXT,
    CHECK (kind <> 'match' OR viewer_account_id IS NOT NULL),
    CHECK (kind <> 'room' OR room_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_cloud_common_ground_match_runs_viewer_open
    ON cloud_common_ground_match_runs (viewer_account_id, created_at DESC)
    WHERE finished_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_cloud_common_ground_match_runs_room_open
    ON cloud_common_ground_match_runs (room_id, created_at DESC)
    WHERE finished_at IS NULL;

-- Themes several people in a room share, valid for the member set and card
-- revisions in `members_key`.
CREATE TABLE IF NOT EXISTS cloud_common_ground_room_themes (
    room_id     UUID PRIMARY KEY REFERENCES cloud_common_ground_rooms(room_id) ON DELETE CASCADE,
    members_key TEXT NOT NULL,
    themes_json JSONB NOT NULL,
    computed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
