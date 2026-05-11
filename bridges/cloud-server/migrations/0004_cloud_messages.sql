-- Peer-to-peer cloud message store for the chat surface.
--
-- This is intentionally separate from `server_messages` — that table
-- was scaffolded in phase 2 of #332 for the Telegram-style fanout /
-- per-recipient E2EE shape, which is more than we need right now and
-- has a different query pattern. `cloud_messages` is a flat 1:1 log:
-- one row per send, sender + recipient as account IDs, plaintext body,
-- delivery + read timestamps. E2EE / group fanout is a later session
-- that can migrate writers to `server_messages` without rewriting
-- callers.

CREATE TABLE IF NOT EXISTS cloud_messages (
    message_id      TEXT PRIMARY KEY,
    from_account_id TEXT NOT NULL
        REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    to_account_id   TEXT NOT NULL
        REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    body            TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    delivered_at    TEXT,
    read_at         TEXT,
    CHECK (from_account_id <> to_account_id)
);

-- Two-index strategy covers both halves of an "A <-> B" conversation
-- query without needing functional indexes on LEAST/GREATEST.
CREATE INDEX IF NOT EXISTS idx_cloud_messages_from_to_created
    ON cloud_messages (from_account_id, to_account_id, created_at);

CREATE INDEX IF NOT EXISTS idx_cloud_messages_to_from_created
    ON cloud_messages (to_account_id, from_account_id, created_at);
