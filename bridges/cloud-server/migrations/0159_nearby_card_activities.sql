-- Keep meeting activities with the card that shared them, not with the account.
CREATE TABLE IF NOT EXISTS cloud_common_ground_nearby_profile_preferences (
    profile_id TEXT PRIMARY KEY
        REFERENCES cloud_common_ground_profiles(profile_id) ON DELETE CASCADE,
    open_to_json JSONB NOT NULL DEFAULT '[]'::jsonb
        CHECK (jsonb_typeof(open_to_json) = 'array'),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Preserve the choices currently advertised by each existing participant.
INSERT INTO cloud_common_ground_nearby_profile_preferences (profile_id, open_to_json)
SELECT profile_id, open_to_json
FROM cloud_common_ground_nearby
WHERE profile_id IS NOT NULL
ON CONFLICT (profile_id) DO NOTHING;
