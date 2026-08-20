CREATE TABLE IF NOT EXISTS cloud_avatar_render_keys (
    renderer_version TEXT NOT NULL,
    style TEXT NOT NULL CHECK (style IN ('lorelei', 'thumbs')),
    seed TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (renderer_version, style, seed)
);

ALTER TABLE cloud_accounts
    ADD COLUMN IF NOT EXISTS avatar_source TEXT NOT NULL DEFAULT 'generated',
    ADD COLUMN IF NOT EXISTS avatar_style TEXT NOT NULL DEFAULT 'lorelei',
    ADD COLUMN IF NOT EXISTS avatar_seed TEXT,
    ADD COLUMN IF NOT EXISTS avatar_renderer_version TEXT NOT NULL DEFAULT 'dicebear-rust-10.6.0-styles-10.5.0',
    ADD COLUMN IF NOT EXISTS avatar_version BIGINT NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS avatar_updated_at TEXT;

UPDATE cloud_accounts
SET avatar_source = CASE
        WHEN avatar_url IS NULL OR avatar_url LIKE 'kordi-pixel-avatar://%' THEN 'generated'
        ELSE 'uploaded'
    END,
    avatar_style = 'lorelei',
    avatar_seed = COALESCE(NULLIF(avatar_seed, ''), account_id),
    avatar_renderer_version = 'dicebear-rust-10.6.0-styles-10.5.0',
    avatar_version = GREATEST(avatar_version, 1),
    avatar_updated_at = COALESCE(avatar_updated_at, updated_at);

UPDATE cloud_accounts
SET avatar_url = 'kordi-avatar://dicebear-rust-10.6.0-styles-10.5.0/lorelei/'
    || avatar_seed || '?version=' || avatar_version
WHERE avatar_source = 'generated';

INSERT INTO cloud_avatar_render_keys (renderer_version, style, seed)
SELECT avatar_renderer_version, avatar_style, avatar_seed
FROM cloud_accounts
ON CONFLICT DO NOTHING;

ALTER TABLE cloud_accounts
    ALTER COLUMN avatar_seed SET NOT NULL,
    ALTER COLUMN avatar_updated_at SET NOT NULL,
    ALTER COLUMN avatar_source DROP DEFAULT,
    ALTER COLUMN avatar_style DROP DEFAULT,
    ALTER COLUMN avatar_renderer_version DROP DEFAULT,
    ALTER COLUMN avatar_version DROP DEFAULT;

ALTER TABLE cloud_accounts
    DROP CONSTRAINT IF EXISTS cloud_accounts_avatar_source_check,
    DROP CONSTRAINT IF EXISTS cloud_accounts_avatar_style_check,
    DROP CONSTRAINT IF EXISTS cloud_accounts_avatar_version_check,
    ADD CONSTRAINT cloud_accounts_avatar_source_check
        CHECK (avatar_source IN ('generated', 'uploaded')),
    ADD CONSTRAINT cloud_accounts_avatar_style_check
        CHECK (avatar_style = 'lorelei'),
    ADD CONSTRAINT cloud_accounts_avatar_version_check
        CHECK (avatar_version > 0);

ALTER TABLE cloud_agent_definitions
    ADD COLUMN IF NOT EXISTS avatar_url TEXT,
    ADD COLUMN IF NOT EXISTS avatar_source TEXT NOT NULL DEFAULT 'generated',
    ADD COLUMN IF NOT EXISTS avatar_style TEXT NOT NULL DEFAULT 'thumbs',
    ADD COLUMN IF NOT EXISTS avatar_seed TEXT,
    ADD COLUMN IF NOT EXISTS avatar_renderer_version TEXT NOT NULL DEFAULT 'dicebear-rust-10.6.0-styles-10.5.0',
    ADD COLUMN IF NOT EXISTS avatar_version BIGINT NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS avatar_updated_at TEXT;

UPDATE cloud_agent_definitions
SET avatar_source = CASE
        WHEN avatar_url IS NULL OR avatar_url LIKE 'kordi-pixel-avatar://%' THEN 'generated'
        ELSE 'uploaded'
    END,
    avatar_style = 'thumbs',
    avatar_seed = COALESCE(NULLIF(avatar_seed, ''), agent_id),
    avatar_renderer_version = 'dicebear-rust-10.6.0-styles-10.5.0',
    avatar_version = GREATEST(avatar_version, 1),
    avatar_updated_at = COALESCE(avatar_updated_at, updated_at);

UPDATE cloud_agent_definitions
SET avatar_url = 'kordi-avatar://dicebear-rust-10.6.0-styles-10.5.0/thumbs/'
    || avatar_seed || '?version=' || avatar_version
WHERE avatar_source = 'generated';

INSERT INTO cloud_avatar_render_keys (renderer_version, style, seed)
SELECT avatar_renderer_version, avatar_style, avatar_seed
FROM cloud_agent_definitions
ON CONFLICT DO NOTHING;

ALTER TABLE cloud_agent_definitions
    ALTER COLUMN avatar_seed SET NOT NULL,
    ALTER COLUMN avatar_updated_at SET NOT NULL,
    ALTER COLUMN avatar_source DROP DEFAULT,
    ALTER COLUMN avatar_style DROP DEFAULT,
    ALTER COLUMN avatar_renderer_version DROP DEFAULT,
    ALTER COLUMN avatar_version DROP DEFAULT;

ALTER TABLE cloud_agent_definitions
    DROP CONSTRAINT IF EXISTS cloud_agent_definitions_avatar_source_check,
    DROP CONSTRAINT IF EXISTS cloud_agent_definitions_avatar_style_check,
    DROP CONSTRAINT IF EXISTS cloud_agent_definitions_avatar_version_check,
    ADD CONSTRAINT cloud_agent_definitions_avatar_source_check
        CHECK (avatar_source IN ('generated', 'uploaded')),
    ADD CONSTRAINT cloud_agent_definitions_avatar_style_check
        CHECK (avatar_style = 'thumbs'),
    ADD CONSTRAINT cloud_agent_definitions_avatar_version_check
        CHECK (avatar_version > 0);
