CREATE TABLE IF NOT EXISTS cloud_agent_run_artifacts (
    artifact_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES cloud_agent_fallback_runs(run_id) ON DELETE CASCADE,
    sandbox_id TEXT NOT NULL REFERENCES cloud_agent_sandboxes(sandbox_id) ON DELETE RESTRICT,
    attachment_id TEXT NOT NULL REFERENCES cloud_attachments(attachment_id) ON DELETE RESTRICT,
    message_id TEXT NOT NULL REFERENCES cloud_messages(message_id) ON DELETE CASCADE,
    sandbox_path TEXT NOT NULL,
    name TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size_bytes BIGINT NOT NULL,
    sha256_hex TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cloud_agent_run_artifacts_run_created
    ON cloud_agent_run_artifacts(run_id, created_at);

CREATE INDEX IF NOT EXISTS idx_cloud_agent_run_artifacts_attachment
    ON cloud_agent_run_artifacts(attachment_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_agent_run_artifacts_run_path_sha
    ON cloud_agent_run_artifacts(run_id, sandbox_path, sha256_hex)
    WHERE sha256_hex IS NOT NULL;
