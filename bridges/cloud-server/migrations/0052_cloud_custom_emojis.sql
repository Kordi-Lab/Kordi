-- Workspace/global custom emoji metadata. Assets reuse the hardened cloud
-- attachment store; records are soft-disabled so historical messages retain
-- their immutable emoji identity and fallback shortcode.

CREATE TABLE IF NOT EXISTS cloud_custom_emojis (
    emoji_id            TEXT PRIMARY KEY,
    scope_type          TEXT NOT NULL CHECK (scope_type IN ('global', 'workspace')),
    scope_id            TEXT,
    name                TEXT NOT NULL,
    asset_attachment_id TEXT NOT NULL
        REFERENCES cloud_attachments(attachment_id) ON DELETE RESTRICT,
    animated            BOOLEAN NOT NULL DEFAULT FALSE,
    status              TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'active', 'rejected', 'disabled')),
    uploaded_by         TEXT NOT NULL
        REFERENCES cloud_accounts(account_id) ON DELETE RESTRICT,
    approved_by         TEXT
        REFERENCES cloud_accounts(account_id) ON DELETE SET NULL,
    version             INTEGER NOT NULL DEFAULT 1,
    width               INTEGER NOT NULL DEFAULT 128,
    height              INTEGER NOT NULL DEFAULT 128,
    mime_type           TEXT NOT NULL DEFAULT 'image/webp',
    size_bytes          BIGINT NOT NULL,
    sha256_hex          TEXT NOT NULL,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,
    deleted_at          TEXT,
    CHECK (
        (scope_type = 'global' AND scope_id IS NULL)
        OR (scope_type = 'workspace' AND scope_id IS NOT NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_custom_emoji_active_name
    ON cloud_custom_emojis (scope_type, COALESCE(scope_id, ''), lower(name))
    WHERE deleted_at IS NULL AND status IN ('pending', 'active');

CREATE INDEX IF NOT EXISTS idx_cloud_custom_emoji_scope_status
    ON cloud_custom_emojis (scope_type, scope_id, status, updated_at);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'fk_cloud_message_reactions_custom_emoji'
    ) THEN
        ALTER TABLE cloud_message_reactions
            ADD CONSTRAINT fk_cloud_message_reactions_custom_emoji
            FOREIGN KEY (custom_emoji_id)
            REFERENCES cloud_custom_emojis(emoji_id)
            ON DELETE RESTRICT;
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS cloud_custom_emoji_aliases (
    scope_type TEXT NOT NULL CHECK (scope_type IN ('global', 'workspace')),
    scope_id   TEXT,
    alias      TEXT NOT NULL,
    emoji_id   TEXT NOT NULL
        REFERENCES cloud_custom_emojis(emoji_id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    CHECK (
        (scope_type = 'global' AND scope_id IS NULL)
        OR (scope_type = 'workspace' AND scope_id IS NOT NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_custom_emoji_alias_name
    ON cloud_custom_emoji_aliases (scope_type, COALESCE(scope_id, ''), lower(alias));

CREATE INDEX IF NOT EXISTS idx_cloud_custom_emoji_alias_emoji
    ON cloud_custom_emoji_aliases (emoji_id);

CREATE TABLE IF NOT EXISTS cloud_custom_emoji_upload_attempts (
    attempt_id   TEXT PRIMARY KEY,
    account_id   TEXT NOT NULL
        REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    attempted_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cloud_custom_emoji_upload_attempt_account_time
    ON cloud_custom_emoji_upload_attempts (account_id, attempted_at);

CREATE TABLE IF NOT EXISTS cloud_custom_emoji_audit_log (
    event_id   TEXT PRIMARY KEY,
    emoji_id   TEXT,
    scope_id   TEXT,
    actor_id   TEXT NOT NULL
        REFERENCES cloud_accounts(account_id) ON DELETE RESTRICT,
    action     TEXT NOT NULL,
    detail_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cloud_custom_emoji_audit_scope_time
    ON cloud_custom_emoji_audit_log (scope_id, created_at);
