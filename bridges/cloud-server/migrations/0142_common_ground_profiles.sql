-- Common ground profiles: a person keeps several cards, one per profile
-- (work, health, daily tasks, or a custom one with its own name). Every room
-- membership, pairing and match is tied to one profile of each person, and
-- people only see the profile shared with them there.

CREATE TABLE IF NOT EXISTS cloud_common_ground_profiles (
    profile_id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    kind       TEXT NOT NULL CHECK (kind IN ('work', 'health', 'daily', 'custom')),
    name       TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
    -- One line the card build reads as the profile's lens.
    focus      TEXT NULL CHECK (focus IS NULL OR char_length(focus) <= 200),
    position   INT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (account_id, position)
);

-- At most one profile per fixed kind; any number of custom ones.
CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_common_ground_profiles_fixed_kind
    ON cloud_common_ground_profiles (account_id, kind)
    WHERE kind <> 'custom';

-- Everyone who already uses Common ground gets a work profile, which takes
-- over their card, rooms, pairings and matches.
INSERT INTO cloud_common_ground_profiles (profile_id, account_id, kind, name, position)
SELECT 'cgp_' || md5(used.account_id || clock_timestamp()::text || random()::text),
       used.account_id, 'work', 'Work', 0
FROM (
    SELECT account_id FROM cloud_common_ground_cards
    UNION SELECT account_id FROM cloud_common_ground_room_members
    UNION SELECT account_a FROM cloud_common_ground_pairings
    UNION SELECT account_b FROM cloud_common_ground_pairings
    UNION SELECT account_id FROM cloud_common_ground_pairing_codes
    UNION SELECT viewer_account_id FROM cloud_common_ground_matches
    UNION SELECT other_account_id FROM cloud_common_ground_matches
    UNION SELECT viewer_account_id FROM cloud_common_ground_match_runs
        WHERE viewer_account_id IS NOT NULL
) used
WHERE NOT EXISTS (
    SELECT 1 FROM cloud_common_ground_profiles existing
    WHERE existing.account_id = used.account_id
);

-- Cards: one per profile.
ALTER TABLE cloud_common_ground_cards
    ADD COLUMN profile_id TEXT REFERENCES cloud_common_ground_profiles(profile_id) ON DELETE CASCADE;
UPDATE cloud_common_ground_cards card SET profile_id = profile.profile_id
FROM cloud_common_ground_profiles profile
WHERE profile.account_id = card.account_id AND profile.kind = 'work';
ALTER TABLE cloud_common_ground_cards ALTER COLUMN profile_id SET NOT NULL;
ALTER TABLE cloud_common_ground_cards DROP CONSTRAINT cloud_common_ground_cards_pkey;
ALTER TABLE cloud_common_ground_cards ADD PRIMARY KEY (profile_id);
CREATE INDEX IF NOT EXISTS idx_cloud_common_ground_cards_account
    ON cloud_common_ground_cards (account_id);

-- Rooms suggest a kind that joiners get preselected.
ALTER TABLE cloud_common_ground_rooms
    ADD COLUMN kind TEXT NULL CHECK (kind IN ('work', 'health', 'daily', 'custom'));

-- The profile each member shares in a room. Deleting the profile leaves.
ALTER TABLE cloud_common_ground_room_members
    ADD COLUMN profile_id TEXT REFERENCES cloud_common_ground_profiles(profile_id) ON DELETE CASCADE;
UPDATE cloud_common_ground_room_members member SET profile_id = profile.profile_id
FROM cloud_common_ground_profiles profile
WHERE profile.account_id = member.account_id AND profile.kind = 'work';
ALTER TABLE cloud_common_ground_room_members ALTER COLUMN profile_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cloud_common_ground_room_members_profile
    ON cloud_common_ground_room_members (profile_id);

-- Pairing codes and pairings name the profile each side shares.
ALTER TABLE cloud_common_ground_pairing_codes
    ADD COLUMN profile_id TEXT REFERENCES cloud_common_ground_profiles(profile_id) ON DELETE CASCADE;
UPDATE cloud_common_ground_pairing_codes code SET profile_id = profile.profile_id
FROM cloud_common_ground_profiles profile
WHERE profile.account_id = code.account_id AND profile.kind = 'work';
ALTER TABLE cloud_common_ground_pairing_codes ALTER COLUMN profile_id SET NOT NULL;

-- `profile_a` belongs to `account_a`. Two people may pair once per pair of
-- profiles.
ALTER TABLE cloud_common_ground_pairings
    ADD COLUMN profile_a TEXT REFERENCES cloud_common_ground_profiles(profile_id) ON DELETE CASCADE,
    ADD COLUMN profile_b TEXT REFERENCES cloud_common_ground_profiles(profile_id) ON DELETE CASCADE;
UPDATE cloud_common_ground_pairings pairing SET
    profile_a = (SELECT profile_id FROM cloud_common_ground_profiles
                 WHERE account_id = pairing.account_a AND kind = 'work'),
    profile_b = (SELECT profile_id FROM cloud_common_ground_profiles
                 WHERE account_id = pairing.account_b AND kind = 'work');
ALTER TABLE cloud_common_ground_pairings
    ALTER COLUMN profile_a SET NOT NULL,
    ALTER COLUMN profile_b SET NOT NULL;
ALTER TABLE cloud_common_ground_pairings DROP CONSTRAINT cloud_common_ground_pairings_pkey;
ALTER TABLE cloud_common_ground_pairings ADD PRIMARY KEY (profile_a, profile_b);
CREATE INDEX IF NOT EXISTS idx_cloud_common_ground_pairings_accounts
    ON cloud_common_ground_pairings (account_a, account_b);
CREATE INDEX IF NOT EXISTS idx_cloud_common_ground_pairings_profile_b
    ON cloud_common_ground_pairings (profile_b);

-- Matches are per pair of profiles, valid for the two card revisions they
-- were computed from.
ALTER TABLE cloud_common_ground_matches
    ADD COLUMN viewer_profile_id TEXT REFERENCES cloud_common_ground_profiles(profile_id) ON DELETE CASCADE,
    ADD COLUMN other_profile_id TEXT REFERENCES cloud_common_ground_profiles(profile_id) ON DELETE CASCADE;
UPDATE cloud_common_ground_matches m SET
    viewer_profile_id = (SELECT profile_id FROM cloud_common_ground_profiles
                         WHERE account_id = m.viewer_account_id AND kind = 'work'),
    other_profile_id = (SELECT profile_id FROM cloud_common_ground_profiles
                        WHERE account_id = m.other_account_id AND kind = 'work');
ALTER TABLE cloud_common_ground_matches
    ALTER COLUMN viewer_profile_id SET NOT NULL,
    ALTER COLUMN other_profile_id SET NOT NULL;
ALTER TABLE cloud_common_ground_matches DROP CONSTRAINT cloud_common_ground_matches_pkey;
ALTER TABLE cloud_common_ground_matches ADD PRIMARY KEY (viewer_profile_id, other_profile_id);
CREATE INDEX IF NOT EXISTS idx_cloud_common_ground_matches_other_profile
    ON cloud_common_ground_matches (other_profile_id);

-- A match run works for one viewer profile.
ALTER TABLE cloud_common_ground_match_runs
    ADD COLUMN viewer_profile_id TEXT REFERENCES cloud_common_ground_profiles(profile_id) ON DELETE CASCADE;
UPDATE cloud_common_ground_match_runs run SET viewer_profile_id = profile.profile_id
FROM cloud_common_ground_profiles profile
WHERE profile.account_id = run.viewer_account_id AND profile.kind = 'work';
CREATE INDEX IF NOT EXISTS idx_cloud_common_ground_match_runs_viewer_profile
    ON cloud_common_ground_match_runs (viewer_profile_id, created_at DESC);
