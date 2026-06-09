CREATE TABLE IF NOT EXISTS scheduled_tool_tasks (
    task_id TEXT PRIMARY KEY,
    owner_account_id TEXT NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    created_by_account_id TEXT NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    prompt TEXT NOT NULL,
    tool_payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    schedule_json JSONB NOT NULL,
    timezone TEXT NOT NULL DEFAULT 'UTC',
    target_runtime TEXT NOT NULL CHECK (target_runtime IN ('cloud', 'local_required')),
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'deleted')),
    next_run_at TEXT,
    last_run_at TEXT,
    last_run_status TEXT,
    last_run_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_scheduled_tool_tasks_owner_updated
    ON scheduled_tool_tasks(owner_account_id, updated_at DESC, task_id);

CREATE INDEX IF NOT EXISTS idx_scheduled_tool_tasks_due
    ON scheduled_tool_tasks(enabled, status, next_run_at, task_id)
    WHERE enabled = TRUE AND status = 'active' AND next_run_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS scheduled_tool_task_runs (
    run_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES scheduled_tool_tasks(task_id) ON DELETE CASCADE,
    owner_account_id TEXT NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('queued', 'waiting_for_desktop', 'leased', 'running', 'completed', 'failed', 'cancelled')),
    target_runtime TEXT NOT NULL CHECK (target_runtime IN ('cloud', 'local_required')),
    due_at TEXT NOT NULL,
    lease_expires_at TEXT,
    claimed_by TEXT,
    result_message TEXT,
    error_code TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_scheduled_tool_task_runs_task_due
    ON scheduled_tool_task_runs(task_id, due_at);

CREATE INDEX IF NOT EXISTS idx_scheduled_tool_task_runs_owner_updated
    ON scheduled_tool_task_runs(owner_account_id, updated_at DESC, run_id);

CREATE INDEX IF NOT EXISTS idx_scheduled_tool_task_runs_claim_cloud
    ON scheduled_tool_task_runs(status, target_runtime, lease_expires_at, created_at)
    WHERE target_runtime = 'cloud' AND status IN ('queued', 'leased');

CREATE INDEX IF NOT EXISTS idx_scheduled_tool_task_runs_waiting_desktop
    ON scheduled_tool_task_runs(owner_account_id, status, created_at)
    WHERE target_runtime = 'local_required' AND status = 'waiting_for_desktop';
