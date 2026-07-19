-- Account-synchronized session titles. Stable session ids remain in message
-- storage; this table carries only user-visible naming metadata and a
-- deterministic precedence/revision model.
CREATE TABLE IF NOT EXISTS cloud_session_titles (
    session_id                       TEXT PRIMARY KEY,
    title                            TEXT NOT NULL,
    title_source                     TEXT NOT NULL
        CHECK (title_source IN ('placeholder', 'auto', 'imported', 'external', 'legacy', 'manual')),
    title_revision                   BIGINT NOT NULL DEFAULT 0,
    title_policy_version             BIGINT NOT NULL DEFAULT 1,
    title_generated_from_message_id  TEXT,
    client_updated_at_ms             BIGINT NOT NULL DEFAULT 0,
    updated_by_account_id            TEXT NOT NULL
        REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    updated_at                       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cloud_session_titles_updated_by
    ON cloud_session_titles (updated_by_account_id, updated_at);
