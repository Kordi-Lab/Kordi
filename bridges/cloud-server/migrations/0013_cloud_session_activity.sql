-- Cloud-native session activity records for artifacts and task rows.
-- Rows are session-scoped and participant-visible; sync fanout is via
-- account-scoped cloud_sync_events.

CREATE TABLE IF NOT EXISTS cloud_session_tasks (
    task_activity_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT,
    status TEXT NOT NULL,
    created_by_account_id TEXT NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    target_account_id TEXT REFERENCES cloud_accounts(account_id) ON DELETE SET NULL,
    participants_json JSONB NOT NULL,
    artifact_ids_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    response_message_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT,
    UNIQUE (session_id, task_id)
);

CREATE INDEX IF NOT EXISTS idx_cloud_session_tasks_session_updated
    ON cloud_session_tasks (session_id, updated_at);

CREATE INDEX IF NOT EXISTS idx_cloud_session_tasks_creator_updated
    ON cloud_session_tasks (created_by_account_id, updated_at);

CREATE TABLE IF NOT EXISTS cloud_session_artifacts (
    artifact_activity_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    artifact_id TEXT NOT NULL,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    kind TEXT NOT NULL,
    category TEXT NOT NULL,
    summary TEXT,
    created_by_account_id TEXT NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    source_message_id TEXT,
    attachment_id TEXT REFERENCES cloud_attachments(attachment_id) ON DELETE SET NULL,
    content_type TEXT,
    size_bytes BIGINT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT,
    UNIQUE (session_id, artifact_id)
);

CREATE INDEX IF NOT EXISTS idx_cloud_session_artifacts_session_updated
    ON cloud_session_artifacts (session_id, updated_at);

CREATE INDEX IF NOT EXISTS idx_cloud_session_artifacts_creator_updated
    ON cloud_session_artifacts (created_by_account_id, updated_at);
