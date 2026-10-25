-- New default agents start with a random Kordi bird, and every agent still on
-- the generated DiceBear `thumbs` default moves to `kordi-birds` (issue #2057).
--
-- Moved rows keep their seed, so each agent keeps the bird that updated clients
-- already draw for it (a seed without the `bird-` prefix hashes to one bird),
-- and take `version + 1`. Uploaded photos, picked birds and people's avatars are
-- unchanged. The old `thumbs` render keys stay allowed, so cached avatar URLs
-- and older clients still resolve. Each statement matches only rows still on
-- `thumbs`, so running this again changes nothing.
--
-- Release order: ship a desktop build that renders `kordi-birds` agents before
-- this reaches production (docs/avatar-system.md).

-- A random structured seed in the default tone. The tables match
-- `src/avatars/birds.rs` in the same order; a unit test pins them.
CREATE OR REPLACE FUNCTION random_bird_avatar_seed()
RETURNS TEXT
LANGUAGE sql
VOLATILE
AS $$
    SELECT 'bird-'
        || species[1 + floor(random() * cardinality(species))::int]
        || '-color-'
        || palettes[1 + floor(random() * cardinality(palettes))::int]
    FROM (SELECT
        ARRAY['sparrow', 'robin', 'cardinal', 'jay', 'kingfisher', 'hummingbird', 'owl', 'osprey', 'sparrowhawk', 'eagle', 'penguin', 'puffin', 'toucan', 'heron', 'blackbird', 'cockatoo'] AS species,
        ARRAY['paper', 'rice', 'coral', 'sakura', 'butter', 'mint', 'sky', 'lavender'] AS palettes
    ) AS birds
$$;

CREATE OR REPLACE FUNCTION create_default_agent_profile_for_account()
RETURNS trigger AS $$
DECLARE
    bird_seed TEXT := random_bird_avatar_seed();
BEGIN
    INSERT INTO cloud_default_agent_profiles (
        owner_account_id, display_name, avatar_url, avatar_source, avatar_style,
        avatar_seed, avatar_renderer_version, avatar_version, avatar_updated_at,
        created_at, updated_at
    ) VALUES (
        NEW.account_id,
        'Kordi',
        'kordi-avatar://dicebear-rust-10.6.0-styles-10.5.0/kordi-birds/' || bird_seed || '?version=1',
        'generated',
        'kordi-birds',
        bird_seed,
        'dicebear-rust-10.6.0-styles-10.5.0',
        1,
        NEW.updated_at,
        NEW.created_at,
        NEW.updated_at
    ) ON CONFLICT (owner_account_id) DO NOTHING;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

INSERT INTO cloud_avatar_render_keys (renderer_version, style, seed)
SELECT avatar_renderer_version, avatar_style, avatar_seed
FROM cloud_agent_definitions
WHERE avatar_source = 'generated' AND avatar_style = 'thumbs'
UNION
SELECT avatar_renderer_version, avatar_style, avatar_seed
FROM cloud_default_agent_profiles
WHERE avatar_source = 'generated' AND avatar_style = 'thumbs'
ON CONFLICT DO NOTHING;

UPDATE cloud_agent_definitions
SET avatar_style = 'kordi-birds',
    avatar_renderer_version = 'dicebear-rust-10.6.0-styles-10.5.0',
    avatar_version = avatar_version + 1,
    avatar_url = 'kordi-avatar://dicebear-rust-10.6.0-styles-10.5.0/kordi-birds/'
        || avatar_seed || '?version=' || (avatar_version + 1),
    avatar_updated_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"')
WHERE avatar_source = 'generated' AND avatar_style = 'thumbs';

UPDATE cloud_default_agent_profiles
SET avatar_style = 'kordi-birds',
    avatar_renderer_version = 'dicebear-rust-10.6.0-styles-10.5.0',
    avatar_version = avatar_version + 1,
    avatar_url = 'kordi-avatar://dicebear-rust-10.6.0-styles-10.5.0/kordi-birds/'
        || avatar_seed || '?version=' || (avatar_version + 1),
    avatar_updated_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"')
WHERE avatar_source = 'generated' AND avatar_style = 'thumbs';
