-- Documents an agent creates with create_document (issue 1808). A document is
-- recorded against its run and attached to the run's reply when the reply is
-- published; `attached_at` stays NULL until then. A document created after the
-- run answered (by a background task) waits for the follow-up reply instead.
-- A document that no reply took is posted as the agent's own message.

CREATE TABLE IF NOT EXISTS cloud_agent_run_documents (
    attachment_id TEXT PRIMARY KEY REFERENCES cloud_attachments(attachment_id) ON DELETE CASCADE,
    run_id TEXT NOT NULL REFERENCES cloud_agent_fallback_runs(run_id) ON DELETE CASCADE,
    session_id TEXT NOT NULL,
    owner_account_id TEXT NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL,
    title TEXT NOT NULL,
    file_name TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size_bytes BIGINT NOT NULL,
    after_reply BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    attached_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_cloud_agent_run_documents_pending_run
    ON cloud_agent_run_documents (run_id, created_at)
    WHERE attached_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_cloud_agent_run_documents_pending_session
    ON cloud_agent_run_documents (session_id, owner_account_id, created_at)
    WHERE attached_at IS NULL;
