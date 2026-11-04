-- Indexes on the organization ownership columns from 0163, apart from it so
-- that migration stays short. The runner applies each migration in one
-- transaction, so these are plain CREATE INDEX: writes to each table wait
-- while its index builds, and a busy lock fails the migration fast instead
-- of queueing writes behind it. They serve per-organization reads and keep
-- the foreign key check cheap when an organization is deleted.
SET LOCAL lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS idx_cloud_chat_conversations_organization
    ON cloud_chat_conversations (organization_id);
CREATE INDEX IF NOT EXISTS idx_cloud_agent_definitions_organization
    ON cloud_agent_definitions (organization_id);
CREATE INDEX IF NOT EXISTS idx_cloud_agent_fallback_runs_organization
    ON cloud_agent_fallback_runs (organization_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_tool_tasks_organization
    ON scheduled_tool_tasks (organization_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_tool_task_runs_organization
    ON scheduled_tool_task_runs (organization_id);
CREATE INDEX IF NOT EXISTS idx_cloud_attachments_organization
    ON cloud_attachments (organization_id);
