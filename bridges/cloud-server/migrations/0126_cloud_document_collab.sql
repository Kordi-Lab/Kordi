-- Collaborative editing rooms (issue 1741). One Yjs room per canonical
-- document. `state` is the compacted Y document (a v1 update from the empty
-- state) covering every update up to `seq`; later updates are appended to
-- `cloud_document_collab_updates` and folded into `state` on compaction.
-- The init grant hands the first editor the job of building the Y document
-- from Markdown; `stale_revision` tells the next editor that a revisioned
-- save landed while the room existed.

CREATE TABLE IF NOT EXISTS cloud_document_collab (
    attachment_id          TEXT PRIMARY KEY
                           REFERENCES cloud_attachments(attachment_id) ON DELETE CASCADE,
    state                  BYTEA NOT NULL DEFAULT '\x'::bytea,
    state_vector           BYTEA NOT NULL DEFAULT '\x'::bytea,
    seq                    BIGINT NOT NULL DEFAULT 0 CHECK (seq >= 0),
    initialized_at         TIMESTAMPTZ,
    init_granted_to        TEXT REFERENCES cloud_accounts(account_id) ON DELETE SET NULL,
    init_grant_expires_at  TIMESTAMPTZ,
    stale_revision         BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cloud_document_collab_updates (
    attachment_id TEXT NOT NULL
                  REFERENCES cloud_document_collab(attachment_id) ON DELETE CASCADE,
    seq           BIGINT NOT NULL CHECK (seq >= 1),
    update        BYTEA NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (attachment_id, seq)
);

-- Single-use, session-bound socket tickets, like the chat realtime tickets,
-- bound to one canonical document.
CREATE TABLE IF NOT EXISTS cloud_document_collab_tickets (
    ticket_hash             TEXT PRIMARY KEY,
    attachment_id           TEXT NOT NULL
                            REFERENCES cloud_attachments(attachment_id) ON DELETE CASCADE,
    requested_attachment_id TEXT NOT NULL,
    account_id              TEXT NOT NULL
                            REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    device_id               TEXT NOT NULL,
    session_token_id        TEXT NOT NULL,
    allowed_origin          TEXT,
    expires_at              TIMESTAMPTZ NOT NULL,
    consumed_at             TIMESTAMPTZ,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cloud_document_collab_tickets_expiry
    ON cloud_document_collab_tickets(expires_at);
