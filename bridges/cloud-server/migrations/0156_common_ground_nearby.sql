-- Grounding nearby people (#2100, docs/development/grounding-nearby.md).
-- A person who turns Nearby on shares one profile with other participants
-- around them and sees theirs. Locations are kept per device, rounded to
-- 3 decimals, and count only while fresh. Requests ("needs") describe who
-- the person wants to meet; the server checks nearby people against them
-- and sends deduplicated, capped alerts. Deleting an account removes
-- everything here.

-- One row per account: the setting, the shared profile, filters, alert
-- preferences, and `dirty_at` for the alert sweep.
CREATE TABLE IF NOT EXISTS cloud_common_ground_nearby (
    account_id            TEXT PRIMARY KEY
        REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    enabled               BOOLEAN NOT NULL DEFAULT FALSE,
    profile_id            TEXT
        REFERENCES cloud_common_ground_profiles(profile_id) ON DELETE SET NULL,
    paused_until          TIMESTAMPTZ,
    consented_at          TIMESTAMPTZ,
    -- What the person is open to right now ("Coffee chat"), up to 5 labels.
    open_to_json          JSONB NOT NULL DEFAULT '[]'::jsonb,
    range_m               INT NOT NULL DEFAULT 2000,
    min_score             INT NOT NULL DEFAULT 0,
    alert_requests        BOOLEAN NOT NULL DEFAULT TRUE,
    alert_matches         BOOLEAN NOT NULL DEFAULT TRUE,
    alert_match_min_score INT NOT NULL DEFAULT 85,
    alert_max_per_day     INT NOT NULL DEFAULT 3,
    dirty_at              TIMESTAMPTZ,
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cloud_common_ground_nearby_dirty
    ON cloud_common_ground_nearby (dirty_at)
    WHERE dirty_at IS NOT NULL;

-- The last location each device sent, rounded to 3 decimals (about 110 m).
-- Precise coordinates are never stored.
CREATE TABLE IF NOT EXISTS cloud_common_ground_nearby_locations (
    device_id   TEXT PRIMARY KEY
        REFERENCES cloud_devices(device_id) ON DELETE CASCADE,
    account_id  TEXT NOT NULL
        REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    latitude    DOUBLE PRECISION NOT NULL CHECK (latitude BETWEEN -90 AND 90),
    longitude   DOUBLE PRECISION NOT NULL CHECK (longitude BETWEEN -180 AND 180),
    accuracy_m  DOUBLE PRECISION NOT NULL,
    captured_at TIMESTAMPTZ NOT NULL,
    fresh_until TIMESTAMPTZ NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cloud_common_ground_nearby_locations_fresh
    ON cloud_common_ground_nearby_locations (fresh_until);
CREATE INDEX IF NOT EXISTS idx_cloud_common_ground_nearby_locations_account
    ON cloud_common_ground_nearby_locations (account_id);

-- Requests: who the person wants to meet, with an optional time window.
-- Any change to the text, range or window increments `revision`.
CREATE TABLE IF NOT EXISTS cloud_common_ground_nearby_needs (
    need_id    TEXT PRIMARY KEY,
    account_id TEXT NOT NULL
        REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    text       TEXT NOT NULL CHECK (char_length(text) BETWEEN 1 AND 200),
    range_m    INT NOT NULL,
    starts_at  TIMESTAMPTZ,
    ends_at    TIMESTAMPTZ,
    paused     BOOLEAN NOT NULL DEFAULT FALSE,
    revision   BIGINT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cloud_common_ground_nearby_needs_account
    ON cloud_common_ground_nearby_needs (account_id);

-- How a nearby person's shared profile stands against a request, valid only
-- for the request revision and card revision it was computed from.
CREATE TABLE IF NOT EXISTS cloud_common_ground_nearby_verdicts (
    need_id          TEXT NOT NULL
        REFERENCES cloud_common_ground_nearby_needs(need_id) ON DELETE CASCADE,
    other_profile_id TEXT NOT NULL
        REFERENCES cloud_common_ground_profiles(profile_id) ON DELETE CASCADE,
    need_revision    BIGINT NOT NULL,
    other_revision   BIGINT NOT NULL,
    met              BOOLEAN NOT NULL,
    -- {conditions: [text], checks: [{condition, verdict, kind, evidence}]}
    checks_json      JSONB NOT NULL DEFAULT '{}'::jsonb,
    computed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (need_id, other_profile_id)
);

CREATE INDEX IF NOT EXISTS idx_cloud_common_ground_nearby_verdicts_other
    ON cloud_common_ground_nearby_verdicts (other_profile_id);

-- Request check runs. `candidates_json` holds the shared material the
-- prompt was built from and is cleared when the run finishes.
CREATE TABLE IF NOT EXISTS cloud_common_ground_nearby_need_runs (
    run_id          TEXT PRIMARY KEY,
    need_id         TEXT NOT NULL
        REFERENCES cloud_common_ground_nearby_needs(need_id) ON DELETE CASCADE,
    need_revision   BIGINT NOT NULL,
    account_id      TEXT NOT NULL
        REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    candidates_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at     TIMESTAMPTZ,
    failed_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_cloud_common_ground_nearby_need_runs_need
    ON cloud_common_ground_nearby_need_runs (need_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cloud_common_ground_nearby_need_runs_account
    ON cloud_common_ground_nearby_need_runs (account_id);

-- Alerts about a nearby person, for a request they meet or a high match.
CREATE TABLE IF NOT EXISTS cloud_common_ground_nearby_alerts (
    alert_id             TEXT PRIMARY KEY,
    recipient_account_id TEXT NOT NULL
        REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    other_account_id     TEXT NOT NULL
        REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    other_profile_id     TEXT NOT NULL
        REFERENCES cloud_common_ground_profiles(profile_id) ON DELETE CASCADE,
    kind                 TEXT NOT NULL CHECK (kind IN ('need', 'match')),
    need_id              TEXT
        REFERENCES cloud_common_ground_nearby_needs(need_id) ON DELETE CASCADE,
    need_revision        BIGINT,
    score                INT,
    distance_max_m       INT NOT NULL,
    status               TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'delivered', 'suppressed', 'invalidated')),
    reason               TEXT,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    delivered_at         TIMESTAMPTZ,
    CHECK (kind <> 'need' OR (need_id IS NOT NULL AND need_revision IS NOT NULL))
);

-- One request alert per recipient, person and request revision. An alert
-- that was invalidated before delivery does not count.
CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_common_ground_nearby_alerts_need
    ON cloud_common_ground_nearby_alerts
       (recipient_account_id, other_account_id, need_id, need_revision)
    WHERE kind = 'need' AND status <> 'invalidated';
CREATE INDEX IF NOT EXISTS idx_cloud_common_ground_nearby_alerts_delivered
    ON cloud_common_ground_nearby_alerts (recipient_account_id, delivered_at);
CREATE INDEX IF NOT EXISTS idx_cloud_common_ground_nearby_alerts_pair
    ON cloud_common_ground_nearby_alerts (recipient_account_id, other_account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cloud_common_ground_nearby_alerts_other
    ON cloud_common_ground_nearby_alerts (other_account_id);
CREATE INDEX IF NOT EXISTS idx_cloud_common_ground_nearby_alerts_pending
    ON cloud_common_ground_nearby_alerts (created_at)
    WHERE status = 'pending';
