CREATE TABLE IF NOT EXISTS cloud_avatar_assets (
    asset_id            TEXT PRIMARY KEY,
    owner_account_id    TEXT NOT NULL
                        REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    entity_type         TEXT NOT NULL CHECK (entity_type IN ('human', 'agent')),
    entity_id           TEXT NOT NULL,
    object_prefix       TEXT NOT NULL UNIQUE,
    source_content_type TEXT NOT NULL,
    source_size_bytes   BIGINT NOT NULL CHECK (source_size_bytes > 0),
    source_width        INTEGER NOT NULL CHECK (source_width > 0),
    source_height       INTEGER NOT NULL CHECK (source_height > 0),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    activated_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_cloud_avatar_assets_entity
    ON cloud_avatar_assets(entity_type, entity_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_cloud_avatar_assets_unactivated
    ON cloud_avatar_assets(created_at)
    WHERE activated_at IS NULL;
