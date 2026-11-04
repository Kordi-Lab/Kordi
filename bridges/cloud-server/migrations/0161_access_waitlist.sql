-- Only server-verified email ownership can create a waitlist entry.
-- Approval is selected through restricted instance configuration, not this table.
CREATE TABLE cloud_access_waitlist (
    email TEXT PRIMARY KEY,
    first_requested_at TIMESTAMPTZ NOT NULL,
    last_requested_at TIMESTAMPTZ NOT NULL
);
