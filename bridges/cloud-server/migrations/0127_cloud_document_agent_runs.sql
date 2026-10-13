-- Agents in shared documents (issue 1741). A comment that mentions an agent
-- starts one run in `cloud_agent_fallback_runs`, linked to the comment. The
-- run's answer is a reply comment written by the agent, so a comment has
-- exactly one author: an account, a public reader, or an agent. An agent
-- edit records the agent next to the account that asked for it.

ALTER TABLE cloud_agent_fallback_runs
    ADD COLUMN IF NOT EXISTS document_comment_id TEXT
        REFERENCES cloud_document_comments(comment_id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_cloud_agent_fallback_runs_document_comment
    ON cloud_agent_fallback_runs(document_comment_id, created_at DESC)
    WHERE document_comment_id IS NOT NULL;

-- A comment run stores its reply comment id in `response_message_id`.
CREATE INDEX IF NOT EXISTS idx_cloud_agent_fallback_runs_document_reply
    ON cloud_agent_fallback_runs(response_message_id)
    WHERE request_message_id LIKE 'doccmt:%' AND response_message_id IS NOT NULL;

ALTER TABLE cloud_document_comments
    ADD COLUMN IF NOT EXISTS author_agent_id TEXT,
    ADD COLUMN IF NOT EXISTS author_agent_name TEXT;

ALTER TABLE cloud_document_comments
    DROP CONSTRAINT IF EXISTS cloud_document_comments_check;
ALTER TABLE cloud_document_comments
    DROP CONSTRAINT IF EXISTS cloud_document_comments_author_check;
ALTER TABLE cloud_document_comments
    ADD CONSTRAINT cloud_document_comments_author_check
    CHECK (
        num_nonnulls(author_account_id, author_reader_key, author_agent_id) = 1
        AND (author_agent_id IS NULL) = (author_agent_name IS NULL)
    );

ALTER TABLE cloud_document_contents
    ADD COLUMN IF NOT EXISTS updated_by_agent_id TEXT;
