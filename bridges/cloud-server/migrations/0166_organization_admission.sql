-- Organization admission from deployment configuration
-- (docs/development/organization-admission.md). Additive only: without an
-- admission file the server creates no configured organization and writes
-- none of these tables.
SET LOCAL lock_timeout = '5s';

-- A team organization created from the admission file carries its
-- configuration id, so startup finds and updates the same row every time.
ALTER TABLE cloud_organizations
    ADD COLUMN IF NOT EXISTS config_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_organizations_config_id
    ON cloud_organizations (config_id)
    WHERE config_id IS NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'cloud_organizations_config_id_check'
    ) THEN
        ALTER TABLE cloud_organizations
            ADD CONSTRAINT cloud_organizations_config_id_check
            CHECK (config_id IS NULL OR kind = 'team');
    END IF;
END;
$$;

-- Admins named by the admission file. Startup and sign-in keep this flag in
-- step with the file; members without it are managed through the API.
ALTER TABLE cloud_organization_members
    ADD COLUMN IF NOT EXISTS configured_admin BOOLEAN NOT NULL DEFAULT false;

-- The Google hosted domain (`hd`) from the provider's ID token at the last
-- sign-in. NULL for other providers and personal Google accounts.
ALTER TABLE cloud_account_identities
    ADD COLUMN IF NOT EXISTS hosted_domain TEXT;

-- How an account was admitted to a configured organization and when it was
-- last verified. The row stays after the membership ends (lapsed_at set) and
-- keeps only the verified email, the decision, the approver and timestamps.
CREATE TABLE IF NOT EXISTS cloud_organization_admissions (
    organization_id        TEXT NOT NULL
        REFERENCES cloud_organizations (organization_id) ON DELETE CASCADE,
    account_id             TEXT NOT NULL
        REFERENCES cloud_accounts (account_id) ON DELETE CASCADE,
    source                 TEXT NOT NULL
        CHECK (source IN ('domain_claim', 'join_request')),
    verified_email         TEXT,
    verification_method    TEXT
        CHECK (verification_method IN ('google', 'email_code', 'github')),
    verified_at            TIMESTAMPTZ NOT NULL,
    expires_at             TIMESTAMPTZ,
    approved_by_account_id TEXT
        REFERENCES cloud_accounts (account_id) ON DELETE SET NULL,
    lapsed_at              TIMESTAMPTZ,
    lapse_reason           TEXT
        CHECK (lapse_reason IN ('reverification_due', 'approval_expired')),
    PRIMARY KEY (organization_id, account_id),
    CONSTRAINT cloud_organization_admissions_lapse_check
        CHECK ((lapsed_at IS NULL) = (lapse_reason IS NULL))
);

-- One active domain-claim membership per verified email and organization,
-- so one inbox cannot admit several accounts.
CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_organization_admissions_email
    ON cloud_organization_admissions (organization_id, lower(verified_email))
    WHERE source = 'domain_claim' AND lapsed_at IS NULL AND verified_email IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_cloud_organization_admissions_due
    ON cloud_organization_admissions (organization_id, verified_at)
    WHERE lapsed_at IS NULL;

-- Join requests. Rows, including their field values, are deleted after the
-- organization's retention period.
CREATE TABLE IF NOT EXISTS cloud_organization_join_requests (
    request_id            TEXT PRIMARY KEY,
    organization_id       TEXT NOT NULL
        REFERENCES cloud_organizations (organization_id) ON DELETE CASCADE,
    account_id            TEXT NOT NULL
        REFERENCES cloud_accounts (account_id) ON DELETE CASCADE,
    fields_json           JSONB NOT NULL,
    status                TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
    created_at            TIMESTAMPTZ NOT NULL,
    decided_at            TIMESTAMPTZ,
    decided_by_account_id TEXT
        REFERENCES cloud_accounts (account_id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_organization_join_requests_open
    ON cloud_organization_join_requests (organization_id, account_id)
    WHERE status <> 'approved';

CREATE INDEX IF NOT EXISTS idx_cloud_organization_join_requests_list
    ON cloud_organization_join_requests (organization_id, status, created_at);

-- Codes proving that the signed-in account can read an organization email,
-- which may differ from its primary email. Rules match
-- cloud_account_email_codes.
CREATE TABLE IF NOT EXISTS cloud_organization_email_codes (
    account_id TEXT PRIMARY KEY REFERENCES cloud_accounts (account_id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    verification_id TEXT NOT NULL UNIQUE,
    code_mac BYTEA NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    resend_after TIMESTAMPTZ NOT NULL,
    window_started_at TIMESTAMPTZ NOT NULL,
    send_count INTEGER NOT NULL CHECK (send_count BETWEEN 1 AND 5),
    attempts_remaining INTEGER NOT NULL CHECK (attempts_remaining BETWEEN 0 AND 5),
    delivered_at TIMESTAMPTZ,
    consumed_at TIMESTAMPTZ
);
