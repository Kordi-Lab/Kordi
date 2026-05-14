-- Track fork lineage between cloud sessions.
--
-- A row in this table means: an account forked their view of `parent_session_id`
-- at `parent_message_id` (NULL for fork-at-root), and the resulting private
-- continuation lives at `fork_session_id`. The forked session's messages are
-- written under the new session_id by the forker; other participants of the
-- source session see only the lineage via the `session-forked` sync event.
--
-- Privacy model: forked-session content stays private to the forker (their
-- account is the only one in `cloud_messages.from_account_id` for that
-- fork_session_id). Source-session participants see lineage only.

CREATE TABLE IF NOT EXISTS cloud_session_forks (
    fork_session_id       TEXT NOT NULL PRIMARY KEY,
    parent_session_id     TEXT NOT NULL,
    parent_message_id     TEXT,
    created_by_account_id TEXT NOT NULL
        REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    created_at            TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cloud_session_forks_parent
    ON cloud_session_forks (parent_session_id, created_at);

CREATE INDEX IF NOT EXISTS idx_cloud_session_forks_created_by
    ON cloud_session_forks (created_by_account_id, created_at);
