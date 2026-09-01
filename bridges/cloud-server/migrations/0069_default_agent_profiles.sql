CREATE TABLE IF NOT EXISTS cloud_default_agent_profiles (
    owner_account_id        TEXT PRIMARY KEY
                            REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    display_name            TEXT NOT NULL DEFAULT 'Kordi',
    avatar_url              TEXT,
    avatar_source           TEXT NOT NULL,
    avatar_style            TEXT NOT NULL,
    avatar_seed             TEXT NOT NULL,
    avatar_renderer_version TEXT NOT NULL,
    avatar_version          BIGINT NOT NULL,
    avatar_updated_at       TEXT NOT NULL,
    created_at              TEXT NOT NULL,
    updated_at              TEXT NOT NULL,
    CONSTRAINT cloud_default_agent_profiles_name_check
        CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 120),
    CONSTRAINT cloud_default_agent_profiles_avatar_source_check
        CHECK (avatar_source IN ('generated', 'uploaded')),
    CONSTRAINT cloud_default_agent_profiles_avatar_style_check
        CHECK (avatar_style = 'thumbs'),
    CONSTRAINT cloud_default_agent_profiles_avatar_version_check
        CHECK (avatar_version > 0)
);

INSERT INTO cloud_default_agent_profiles (
    owner_account_id, display_name, avatar_url, avatar_source, avatar_style,
    avatar_seed, avatar_renderer_version, avatar_version, avatar_updated_at,
    created_at, updated_at
)
SELECT account_id,
       'Kordi',
       'kordi-avatar://dicebear-rust-10.6.0-styles-10.5.0/thumbs/default-agent-' || account_id || '?version=1',
       'generated',
       'thumbs',
       'default-agent-' || account_id,
       'dicebear-rust-10.6.0-styles-10.5.0',
       1,
       updated_at,
       created_at,
       updated_at
FROM cloud_accounts
ON CONFLICT (owner_account_id) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_cloud_default_agent_profiles_updated
    ON cloud_default_agent_profiles(updated_at DESC);

CREATE OR REPLACE FUNCTION create_default_agent_profile_for_account()
RETURNS trigger AS $$
BEGIN
    INSERT INTO cloud_default_agent_profiles (
        owner_account_id, display_name, avatar_url, avatar_source, avatar_style,
        avatar_seed, avatar_renderer_version, avatar_version, avatar_updated_at,
        created_at, updated_at
    ) VALUES (
        NEW.account_id,
        'Kordi',
        'kordi-avatar://dicebear-rust-10.6.0-styles-10.5.0/thumbs/default-agent-' || NEW.account_id || '?version=1',
        'generated',
        'thumbs',
        'default-agent-' || NEW.account_id,
        'dicebear-rust-10.6.0-styles-10.5.0',
        1,
        NEW.updated_at,
        NEW.created_at,
        NEW.updated_at
    ) ON CONFLICT (owner_account_id) DO NOTHING;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS cloud_accounts_default_agent_profile ON cloud_accounts;
CREATE TRIGGER cloud_accounts_default_agent_profile
AFTER INSERT ON cloud_accounts
FOR EACH ROW EXECUTE FUNCTION create_default_agent_profile_for_account();
