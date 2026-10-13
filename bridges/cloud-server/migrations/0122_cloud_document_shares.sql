-- Shared documents (issue 1741). A share is a public read link to one
-- Markdown or HTML attachment. Reactions and comments are keyed by the
-- attachment, not by the share, so revoking a link keeps what people wrote
-- and a new link shows the same thread. Timestamps are RFC 3339 text like
-- the invitation tables.

CREATE TABLE IF NOT EXISTS cloud_document_shares (
    share_id              TEXT PRIMARY KEY CHECK (share_id LIKE 'docshare\_%'),
    token_hash            TEXT NOT NULL UNIQUE,
    attachment_id         TEXT NOT NULL
                          REFERENCES cloud_attachments(attachment_id) ON DELETE CASCADE,
    owner_account_id      TEXT NOT NULL
                          REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    session_id            TEXT,
    access_mode           TEXT NOT NULL DEFAULT 'link' CHECK (access_mode IN ('link')),
    readers_can_ask_agent BOOLEAN NOT NULL DEFAULT TRUE,
    created_at            TEXT NOT NULL,
    revoked_at            TEXT
);

CREATE INDEX IF NOT EXISTS idx_cloud_document_shares_owner_attachment
    ON cloud_document_shares(owner_account_id, attachment_id, created_at DESC);

-- One live link per owner and document: creating a share again returns it.
CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_document_shares_one_live
    ON cloud_document_shares(owner_account_id, attachment_id)
    WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS cloud_document_reactions (
    reaction_id      TEXT PRIMARY KEY,
    attachment_id    TEXT NOT NULL
                     REFERENCES cloud_attachments(attachment_id) ON DELETE CASCADE,
    block_id         TEXT NOT NULL CHECK (block_id ~ '^b[0-9]{1,5}$'),
    reaction         TEXT NOT NULL CHECK (char_length(reaction) BETWEEN 1 AND 16),
    actor_account_id TEXT REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    actor_reader_key TEXT,
    actor_name       TEXT,
    created_at       TEXT NOT NULL,
    deleted_at       TEXT,
    CHECK (
        (actor_account_id IS NOT NULL AND actor_reader_key IS NULL)
        OR (actor_account_id IS NULL AND actor_reader_key IS NOT NULL AND actor_name IS NOT NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_document_reactions_live_account
    ON cloud_document_reactions(attachment_id, block_id, reaction, actor_account_id)
    WHERE deleted_at IS NULL AND actor_account_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_document_reactions_live_reader
    ON cloud_document_reactions(attachment_id, block_id, reaction, actor_reader_key)
    WHERE deleted_at IS NULL AND actor_reader_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_cloud_document_reactions_attachment
    ON cloud_document_reactions(attachment_id, created_at)
    WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS cloud_document_comments (
    comment_id        TEXT PRIMARY KEY CHECK (comment_id LIKE 'doccmt\_%'),
    attachment_id     TEXT NOT NULL
                      REFERENCES cloud_attachments(attachment_id) ON DELETE CASCADE,
    block_id          TEXT NOT NULL CHECK (block_id ~ '^b[0-9]{1,5}$'),
    parent_comment_id TEXT
                      REFERENCES cloud_document_comments(comment_id) ON DELETE CASCADE,
    author_account_id TEXT REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    author_reader_key TEXT,
    author_name       TEXT NOT NULL,
    body              TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
    mentions_agent    BOOLEAN NOT NULL DEFAULT FALSE,
    created_at        TEXT NOT NULL,
    edited_at         TEXT,
    deleted_at        TEXT,
    resolved_at       TEXT,
    CHECK ((author_account_id IS NULL) <> (author_reader_key IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_cloud_document_comments_attachment
    ON cloud_document_comments(attachment_id, created_at)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_cloud_document_comments_parent
    ON cloud_document_comments(parent_comment_id)
    WHERE parent_comment_id IS NOT NULL;
