CREATE TABLE cloud_account_digests (
    account_id TEXT PRIMARY KEY REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    locale TEXT NOT NULL DEFAULT 'en',
    timezone TEXT NOT NULL DEFAULT 'UTC',
    input_hash TEXT NOT NULL DEFAULT '',
    input_json JSONB NOT NULL DEFAULT '{}',
    snapshot_json JSONB,
    snapshot_input_json JSONB,
    active_run_id TEXT,
    error_code TEXT,
    revision BIGINT NOT NULL DEFAULT 0,
    checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    retry_after TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE cloud_digest_feedback (
    account_id TEXT NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    item_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('dismissed','task')),
    task_id TEXT,
    PRIMARY KEY(account_id,item_id)
);
CREATE TABLE cloud_calendar_events (
    account_id TEXT NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    event_id TEXT NOT NULL,
    payload JSONB NOT NULL,
    revision BIGINT NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY(account_id,event_id)
);
CREATE TABLE cloud_calendar_reminder_deliveries (
    account_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    revision BIGINT NOT NULL,
    device_id TEXT NOT NULL REFERENCES cloud_devices(device_id) ON DELETE CASCADE,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    accepted_at TIMESTAMPTZ,
    PRIMARY KEY(account_id,event_id,revision,device_id),
    FOREIGN KEY(account_id,event_id) REFERENCES cloud_calendar_events(account_id,event_id) ON DELETE CASCADE
);
