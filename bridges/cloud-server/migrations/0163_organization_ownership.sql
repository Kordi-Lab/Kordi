-- The organization that owns each top-level record
-- (docs/development/organizations.md). There is no organization selection
-- yet, so a record belongs to the personal organization of the account in
-- its owner column:
--
--   cloud_chat_conversations   created_by_account_id
--   cloud_agent_definitions    owner_account_id
--   cloud_agent_fallback_runs  owner_account_id (the agent owner)
--   scheduled_tool_tasks       owner_account_id
--   scheduled_tool_task_runs   owner_account_id
--   cloud_attachments          owner_account_id
--
-- The column stays nullable. A BEFORE INSERT trigger fills it when a writer
-- leaves it empty, which covers every current insert and older server
-- replicas during a rolling update; a writer that names an organization
-- keeps it. Triggers are installed before the backfill in the same
-- transaction, so no new row is missed. The backfill touches only empty
-- rows, so running it again changes nothing. Indexes are in 0164.
SET LOCAL lock_timeout = '5s';

ALTER TABLE cloud_chat_conversations
    ADD COLUMN IF NOT EXISTS organization_id TEXT
        REFERENCES cloud_organizations (organization_id);
ALTER TABLE cloud_agent_definitions
    ADD COLUMN IF NOT EXISTS organization_id TEXT
        REFERENCES cloud_organizations (organization_id);
ALTER TABLE cloud_agent_fallback_runs
    ADD COLUMN IF NOT EXISTS organization_id TEXT
        REFERENCES cloud_organizations (organization_id);
ALTER TABLE scheduled_tool_tasks
    ADD COLUMN IF NOT EXISTS organization_id TEXT
        REFERENCES cloud_organizations (organization_id);
ALTER TABLE scheduled_tool_task_runs
    ADD COLUMN IF NOT EXISTS organization_id TEXT
        REFERENCES cloud_organizations (organization_id);
ALTER TABLE cloud_attachments
    ADD COLUMN IF NOT EXISTS organization_id TEXT
        REFERENCES cloud_organizations (organization_id);

CREATE OR REPLACE FUNCTION cloud_set_organization_from_owner()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.organization_id := (
        SELECT organization_id FROM cloud_organizations
        WHERE personal_account_id = NEW.owner_account_id
    );
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION cloud_set_organization_from_creator()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.organization_id := (
        SELECT organization_id FROM cloud_organizations
        WHERE personal_account_id = NEW.created_by_account_id
    );
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS cloud_chat_conversations_organization ON cloud_chat_conversations;
CREATE TRIGGER cloud_chat_conversations_organization
BEFORE INSERT ON cloud_chat_conversations
FOR EACH ROW WHEN (NEW.organization_id IS NULL)
EXECUTE FUNCTION cloud_set_organization_from_creator();

DROP TRIGGER IF EXISTS cloud_agent_definitions_organization ON cloud_agent_definitions;
CREATE TRIGGER cloud_agent_definitions_organization
BEFORE INSERT ON cloud_agent_definitions
FOR EACH ROW WHEN (NEW.organization_id IS NULL)
EXECUTE FUNCTION cloud_set_organization_from_owner();

DROP TRIGGER IF EXISTS cloud_agent_fallback_runs_organization ON cloud_agent_fallback_runs;
CREATE TRIGGER cloud_agent_fallback_runs_organization
BEFORE INSERT ON cloud_agent_fallback_runs
FOR EACH ROW WHEN (NEW.organization_id IS NULL)
EXECUTE FUNCTION cloud_set_organization_from_owner();

DROP TRIGGER IF EXISTS scheduled_tool_tasks_organization ON scheduled_tool_tasks;
CREATE TRIGGER scheduled_tool_tasks_organization
BEFORE INSERT ON scheduled_tool_tasks
FOR EACH ROW WHEN (NEW.organization_id IS NULL)
EXECUTE FUNCTION cloud_set_organization_from_owner();

DROP TRIGGER IF EXISTS scheduled_tool_task_runs_organization ON scheduled_tool_task_runs;
CREATE TRIGGER scheduled_tool_task_runs_organization
BEFORE INSERT ON scheduled_tool_task_runs
FOR EACH ROW WHEN (NEW.organization_id IS NULL)
EXECUTE FUNCTION cloud_set_organization_from_owner();

DROP TRIGGER IF EXISTS cloud_attachments_organization ON cloud_attachments;
CREATE TRIGGER cloud_attachments_organization
BEFORE INSERT ON cloud_attachments
FOR EACH ROW WHEN (NEW.organization_id IS NULL)
EXECUTE FUNCTION cloud_set_organization_from_owner();

-- Backfill. No existing UPDATE trigger on these tables reacts to this
-- column, and updated_at is left alone.
UPDATE cloud_chat_conversations r SET organization_id = o.organization_id
FROM cloud_organizations o
WHERE r.organization_id IS NULL AND o.personal_account_id = r.created_by_account_id;

UPDATE cloud_agent_definitions r SET organization_id = o.organization_id
FROM cloud_organizations o
WHERE r.organization_id IS NULL AND o.personal_account_id = r.owner_account_id;

UPDATE cloud_agent_fallback_runs r SET organization_id = o.organization_id
FROM cloud_organizations o
WHERE r.organization_id IS NULL AND o.personal_account_id = r.owner_account_id;

UPDATE scheduled_tool_tasks r SET organization_id = o.organization_id
FROM cloud_organizations o
WHERE r.organization_id IS NULL AND o.personal_account_id = r.owner_account_id;

UPDATE scheduled_tool_task_runs r SET organization_id = o.organization_id
FROM cloud_organizations o
WHERE r.organization_id IS NULL AND o.personal_account_id = r.owner_account_id;

UPDATE cloud_attachments r SET organization_id = o.organization_id
FROM cloud_organizations o
WHERE r.organization_id IS NULL AND o.personal_account_id = r.owner_account_id;
