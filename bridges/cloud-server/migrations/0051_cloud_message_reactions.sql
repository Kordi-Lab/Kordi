-- Durable, normalized reactions attached to the canonical message id shown by
-- clients. Group messages have one delivery row per recipient, so the
-- canonical message id intentionally is not a foreign key to cloud_messages.

CREATE TABLE IF NOT EXISTS cloud_message_reactions (
    session_id       TEXT NOT NULL,
    message_id       TEXT NOT NULL,
    account_id       TEXT NOT NULL
        REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    reaction_kind    TEXT NOT NULL
        CHECK (reaction_kind IN ('unicode', 'custom')),
    reaction_key     TEXT NOT NULL,
    unicode_value    TEXT,
    custom_emoji_id  TEXT,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL,
    CHECK (
        (reaction_kind = 'unicode'
            AND unicode_value IS NOT NULL
            AND custom_emoji_id IS NULL)
        OR
        (reaction_kind = 'custom'
            AND unicode_value IS NULL
            AND custom_emoji_id IS NOT NULL)
    ),
    PRIMARY KEY (session_id, message_id, account_id, reaction_key)
);

CREATE INDEX IF NOT EXISTS idx_cloud_message_reactions_session_message
    ON cloud_message_reactions (session_id, message_id, created_at);
