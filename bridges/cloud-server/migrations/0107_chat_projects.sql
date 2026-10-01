-- Account-scoped desktop project discovery. Filesystem roots stay on the device.
CREATE TABLE cloud_project_devices (
    device_id TEXT PRIMARY KEY REFERENCES cloud_devices(device_id),
    account_id TEXT NOT NULL REFERENCES cloud_accounts(account_id),
    projects JSONB NOT NULL DEFAULT '[]',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX cloud_project_devices_account ON cloud_project_devices(account_id);
CREATE TABLE cloud_project_commands (
    command_id UUID PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES cloud_accounts(account_id),
    device_id TEXT NOT NULL REFERENCES cloud_devices(device_id),
    request JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed')),
    result JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX cloud_project_commands_pending ON cloud_project_commands(device_id, created_at) WHERE status = 'queued';
