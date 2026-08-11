-- Reliable multi-device chat foundation.
--
-- These tables intentionally live beside historical cloud_messages and
-- cloud_sync_events so retained data can be audited/backfilled safely. The
-- product chat routes themselves are v2-only; the old tables are not a live
-- delivery or recovery source.

CREATE TABLE IF NOT EXISTS cloud_chat_conversations (
    conversation_id          UUID PRIMARY KEY,
    kind                     TEXT NOT NULL
                             CHECK (kind IN ('direct', 'group', 'ai')),
    shared_title             TEXT,
    version                  INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_by_account_id    TEXT NOT NULL
                             REFERENCES cloud_accounts(account_id),
    client_operation_id      UUID NOT NULL,
    creation_fingerprint     TEXT NOT NULL,
    legacy_session_id        TEXT UNIQUE,
    next_message_sequence    BIGINT NOT NULL DEFAULT 1
                             CHECK (next_message_sequence >= 1),
    latest_message_sequence  BIGINT NOT NULL DEFAULT 0
                             CHECK (latest_message_sequence >= 0),
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (created_by_account_id, client_operation_id),
    CHECK (latest_message_sequence < next_message_sequence)
);

CREATE TABLE IF NOT EXISTS cloud_chat_conversation_members (
    conversation_id        UUID NOT NULL
                           REFERENCES cloud_chat_conversations(conversation_id)
                           ON DELETE CASCADE,
    account_id             TEXT NOT NULL
                           REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    role                   TEXT NOT NULL DEFAULT 'member'
                           CHECK (role IN ('owner', 'admin', 'member')),
    membership_state       TEXT NOT NULL DEFAULT 'active'
                           CHECK (membership_state IN ('active', 'left', 'removed')),
    version                INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    personal_title         TEXT,
    preferences_version    INTEGER NOT NULL DEFAULT 1
                           CHECK (preferences_version >= 1),
    joined_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    left_at                TIMESTAMPTZ,
    last_delivered_sequence BIGINT NOT NULL DEFAULT 0
                           CHECK (last_delivered_sequence >= 0),
    last_read_sequence     BIGINT NOT NULL DEFAULT 0
                           CHECK (last_read_sequence >= 0),
    muted_until            TIMESTAMPTZ,
    PRIMARY KEY (conversation_id, account_id),
    CHECK (last_read_sequence <= last_delivered_sequence)
);

CREATE INDEX IF NOT EXISTS idx_cloud_chat_members_by_account
    ON cloud_chat_conversation_members(account_id, conversation_id)
    WHERE membership_state = 'active';

CREATE TABLE IF NOT EXISTS cloud_chat_messages (
    message_id             UUID PRIMARY KEY,
    conversation_id        UUID NOT NULL
                           REFERENCES cloud_chat_conversations(conversation_id)
                           ON DELETE CASCADE,
    conversation_sequence  BIGINT NOT NULL CHECK (conversation_sequence >= 1),
    sender_account_id      TEXT NOT NULL
                           REFERENCES cloud_accounts(account_id),
    client_message_id      UUID NOT NULL,
    request_fingerprint    TEXT NOT NULL,
    message_kind           TEXT NOT NULL DEFAULT 'text',
    content                JSONB NOT NULL,
    reply_to_message_id    UUID REFERENCES cloud_chat_messages(message_id),
    version                INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    generation_status      TEXT,
    provider_response_id   TEXT,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    edited_at              TIMESTAMPTZ,
    deleted_at             TIMESTAMPTZ,
    UNIQUE (conversation_id, conversation_sequence),
    UNIQUE (sender_account_id, client_message_id)
);

CREATE INDEX IF NOT EXISTS idx_cloud_chat_messages_history
    ON cloud_chat_messages(conversation_id, conversation_sequence DESC);

CREATE TABLE IF NOT EXISTS cloud_chat_message_attachments (
    message_id     UUID NOT NULL
                   REFERENCES cloud_chat_messages(message_id) ON DELETE CASCADE,
    attachment_id TEXT NOT NULL
                   REFERENCES cloud_attachments(attachment_id),
    position       INTEGER NOT NULL CHECK (position >= 0),
    PRIMARY KEY (message_id, attachment_id),
    UNIQUE (message_id, position)
);

CREATE TABLE IF NOT EXISTS cloud_chat_message_reactions (
    message_id  UUID NOT NULL
                REFERENCES cloud_chat_messages(message_id) ON DELETE CASCADE,
    account_id  TEXT NOT NULL
                REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    reaction    TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at  TIMESTAMPTZ,
    PRIMARY KEY (message_id, account_id, reaction)
);

CREATE TABLE IF NOT EXISTS cloud_chat_user_sync_heads (
    account_id TEXT PRIMARY KEY
               REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    last_seq   BIGINT NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
    min_seq    BIGINT NOT NULL DEFAULT 0 CHECK (min_seq >= 0),
    CHECK (min_seq <= last_seq)
);

CREATE TABLE IF NOT EXISTS cloud_chat_user_sync_events (
    account_id        TEXT NOT NULL
                      REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    stream_seq        BIGINT NOT NULL CHECK (stream_seq >= 1),
    event_id          UUID NOT NULL UNIQUE,
    protocol_version  INTEGER NOT NULL DEFAULT 2,
    event_type        TEXT NOT NULL,
    conversation_id   UUID REFERENCES cloud_chat_conversations(conversation_id)
                      ON DELETE CASCADE,
    entity_id         UUID,
    entity_version    INTEGER,
    critical          BOOLEAN NOT NULL DEFAULT TRUE,
    payload           JSONB NOT NULL,
    occurred_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, stream_seq)
);

CREATE INDEX IF NOT EXISTS idx_cloud_chat_sync_events_retention
    ON cloud_chat_user_sync_events(occurred_at);

-- Non-message mutations use this durable request ledger. Message creation is
-- protected directly by (sender_account_id, client_message_id).
CREATE TABLE IF NOT EXISTS cloud_chat_client_operations (
    account_id          TEXT NOT NULL
                        REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    client_operation_id UUID NOT NULL,
    operation_kind      TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    result              JSONB NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, client_operation_id)
);

-- Explicit maps make the compatibility bridge auditable and reversible.
CREATE TABLE IF NOT EXISTS cloud_chat_legacy_message_map (
    legacy_message_id   TEXT PRIMARY KEY
                        REFERENCES cloud_messages(message_id) ON DELETE CASCADE,
    canonical_message_id UUID NOT NULL
                         REFERENCES cloud_chat_messages(message_id) ON DELETE CASCADE,
    recipient_account_id TEXT NOT NULL
                         REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    UNIQUE (canonical_message_id, recipient_account_id)
);

ALTER TABLE cloud_devices
    ADD COLUMN IF NOT EXISTS protocol_version INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS last_ack_seq BIGINT NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS cloud_push_tokens (
    device_id         TEXT NOT NULL
                      REFERENCES cloud_devices(device_id) ON DELETE CASCADE,
    provider          TEXT NOT NULL CHECK (provider IN ('apns', 'fcm')),
    token_ciphertext  TEXT NOT NULL,
    environment       TEXT,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    invalidated_at    TIMESTAMPTZ,
    PRIMARY KEY (device_id, provider)
);

CREATE TABLE IF NOT EXISTS cloud_chat_realtime_tickets (
    ticket_hash    TEXT PRIMARY KEY,
    account_id     TEXT NOT NULL
                   REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    device_id      TEXT NOT NULL REFERENCES cloud_devices(device_id) ON DELETE CASCADE,
    allowed_origin TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at     TIMESTAMPTZ NOT NULL,
    consumed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_cloud_chat_realtime_tickets_expiry
    ON cloud_chat_realtime_tickets(expires_at)
    WHERE consumed_at IS NULL;
