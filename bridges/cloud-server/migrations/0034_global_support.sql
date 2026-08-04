ALTER TABLE cloud_agent_definitions
    ADD COLUMN IF NOT EXISTS is_system_managed BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_cloud_agent_definitions_system_managed
    ON cloud_agent_definitions(is_system_managed, status);

CREATE TABLE IF NOT EXISTS cloud_support_tickets (
    ticket_id              TEXT PRIMARY KEY,
    account_id             TEXT NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    category               TEXT NOT NULL,
    subject                TEXT NOT NULL,
    description            TEXT NOT NULL,
    session_id             TEXT,
    diagnostics_json       JSONB NOT NULL DEFAULT '{}',
    client_submission_id   TEXT NOT NULL,
    notification_status    TEXT NOT NULL DEFAULT 'pending',
    notification_attempts  INTEGER NOT NULL DEFAULT 0,
    notification_error     TEXT,
    next_notification_attempt_at TEXT NOT NULL,
    notified_at            TEXT,
    created_at             TEXT NOT NULL,
    updated_at             TEXT NOT NULL,
    CONSTRAINT cloud_support_tickets_category_check
        CHECK (category IN ('question', 'issue', 'feedback')),
    CONSTRAINT cloud_support_tickets_notification_status_check
        CHECK (notification_status IN ('pending', 'sending', 'sent')),
    UNIQUE (account_id, client_submission_id)
);

CREATE INDEX IF NOT EXISTS idx_cloud_support_tickets_notification_queue
    ON cloud_support_tickets(notification_status, updated_at, created_at);
