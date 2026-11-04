-- Organizations (docs/development/organizations.md), the foundation for team
-- workspaces. Every account has exactly one personal organization, where it
-- is the only member and the owner. A team organization can have many
-- members. 0163 points owned records at an organization.
--
-- Accounts are created on several paths (sign-up, sign-in providers,
-- built-in service accounts, and older server replicas during a rolling
-- update), so a trigger on cloud_accounts creates the personal organization
-- in the same transaction, like the default agent profile in 0069. The
-- trigger is installed before the backfill, and its lock holds account
-- inserts until this migration commits, so no account is missed.
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS cloud_organizations (
    organization_id       TEXT PRIMARY KEY CHECK (organization_id LIKE 'org\_%'),
    name                  TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
    kind                  TEXT NOT NULL CHECK (kind IN ('personal', 'team')),
    -- The account a personal organization belongs to; NULL for a team.
    -- Deleting the account deletes its personal organization.
    personal_account_id   TEXT UNIQUE
        REFERENCES cloud_accounts (account_id) ON DELETE CASCADE,
    created_by_account_id TEXT
        REFERENCES cloud_accounts (account_id) ON DELETE SET NULL,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT cloud_organizations_personal_account_check
        CHECK ((kind = 'personal') = (personal_account_id IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS cloud_organization_members (
    organization_id TEXT NOT NULL
        REFERENCES cloud_organizations (organization_id) ON DELETE CASCADE,
    account_id      TEXT NOT NULL
        REFERENCES cloud_accounts (account_id) ON DELETE CASCADE,
    role            TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
    joined_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (organization_id, account_id)
);

CREATE INDEX IF NOT EXISTS idx_cloud_organization_members_account
    ON cloud_organization_members (account_id, organization_id);

-- A personal organization has one member: its account, as the owner. The
-- API refuses other changes first; this keeps every writer to the rule.
CREATE OR REPLACE FUNCTION cloud_guard_personal_organization_member()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM cloud_organizations o
        WHERE o.organization_id = NEW.organization_id
          AND o.kind = 'personal'
          AND (o.personal_account_id <> NEW.account_id OR NEW.role <> 'owner')
    ) THEN
        RAISE EXCEPTION 'a personal organization has only its owner'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS cloud_organization_members_personal ON cloud_organization_members;
CREATE TRIGGER cloud_organization_members_personal
BEFORE INSERT OR UPDATE ON cloud_organization_members
FOR EACH ROW EXECUTE FUNCTION cloud_guard_personal_organization_member();

CREATE OR REPLACE FUNCTION cloud_create_personal_organization()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    created TEXT;
BEGIN
    INSERT INTO cloud_organizations (
        organization_id, name, kind, personal_account_id, created_by_account_id
    ) VALUES (
        'org_' || replace(gen_random_uuid()::text, '-', ''),
        'Personal', 'personal', NEW.account_id, NEW.account_id
    )
    ON CONFLICT (personal_account_id) DO NOTHING
    RETURNING organization_id INTO created;
    IF created IS NOT NULL THEN
        INSERT INTO cloud_organization_members (organization_id, account_id, role)
        VALUES (created, NEW.account_id, 'owner')
        ON CONFLICT (organization_id, account_id) DO NOTHING;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS cloud_accounts_personal_organization ON cloud_accounts;
CREATE TRIGGER cloud_accounts_personal_organization
AFTER INSERT ON cloud_accounts
FOR EACH ROW EXECUTE FUNCTION cloud_create_personal_organization();

-- Backfill existing accounts. Both statements skip what already exists, so
-- running them again changes nothing.
INSERT INTO cloud_organizations (
    organization_id, name, kind, personal_account_id, created_by_account_id
)
SELECT 'org_' || replace(gen_random_uuid()::text, '-', ''),
       'Personal', 'personal', account_id, account_id
FROM cloud_accounts
ON CONFLICT (personal_account_id) DO NOTHING;

INSERT INTO cloud_organization_members (organization_id, account_id, role)
SELECT organization_id, personal_account_id, 'owner'
FROM cloud_organizations
WHERE kind = 'personal'
ON CONFLICT (organization_id, account_id) DO NOTHING;
