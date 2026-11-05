-- Organization selection, invitations, and the owner-eligibility rule
-- (docs/development/organizations.md).
--
-- 1. Content may name an organization, but only one its owner belongs to.
--    A BEFORE INSERT/UPDATE trigger on each owned table refuses any other,
--    so every writer, including older replicas, keeps the rule.
-- 2. Members join a team by accepting an invitation; a membership may expire.
--    A team that had an owner keeps one: when its last owner disappears
--    through a cascade, its longest-standing lasting admin becomes the
--    owner. Teams from the admission file (0167) have admins only and are
--    left alone.
-- 3. A team may require that its content is owned by a member. Then content
--    whose owner leaves, is removed, expires, or hands ownership to someone
--    outside the team moves to the owner's personal organization. Runs are
--    stamped when queued and re-checked when they start; a team pays only
--    for work its members own or request.
SET LOCAL lock_timeout = '5s';

ALTER TABLE cloud_organizations
    ADD COLUMN IF NOT EXISTS member_owned_content BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE cloud_organization_members
    ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE cloud_organization_members
    DROP CONSTRAINT IF EXISTS cloud_organization_members_owner_expiry_check;
ALTER TABLE cloud_organization_members
    ADD CONSTRAINT cloud_organization_members_owner_expiry_check
        CHECK (role <> 'owner' OR expires_at IS NULL);
CREATE INDEX IF NOT EXISTS idx_cloud_organization_members_expiry
    ON cloud_organization_members (expires_at) WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS cloud_organization_invitations (
    invitation_id         TEXT PRIMARY KEY CHECK (invitation_id LIKE 'oinv\_%'),
    organization_id       TEXT NOT NULL
        REFERENCES cloud_organizations (organization_id) ON DELETE CASCADE,
    invitee_account_id    TEXT NOT NULL
        REFERENCES cloud_accounts (account_id) ON DELETE CASCADE,
    invited_by_account_id TEXT
        REFERENCES cloud_accounts (account_id) ON DELETE SET NULL,
    role                  TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
    membership_expires_at TIMESTAMPTZ,
    status                TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'accepted', 'declined', 'revoked')),
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at            TIMESTAMPTZ NOT NULL,
    responded_at          TIMESTAMPTZ,
    CONSTRAINT cloud_organization_invitations_owner_expiry_check
        CHECK (role <> 'owner' OR membership_expires_at IS NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_organization_invitations_pending
    ON cloud_organization_invitations (organization_id, invitee_account_id)
    WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_cloud_organization_invitations_invitee
    ON cloud_organization_invitations (invitee_account_id, created_at)
    WHERE status = 'pending';

CREATE OR REPLACE FUNCTION cloud_is_organization_member(p_organization TEXT, p_account TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1 FROM cloud_organization_members
        WHERE organization_id = p_organization AND account_id = p_account
          AND (expires_at IS NULL OR expires_at > now())
    );
$$;

CREATE OR REPLACE FUNCTION cloud_personal_organization(p_account TEXT)
RETURNS TEXT LANGUAGE sql STABLE AS $$
    SELECT organization_id FROM cloud_organizations WHERE personal_account_id = p_account;
$$;

-- A conversation's owner: its active member with the owner role, or else
-- the account that created it.
CREATE OR REPLACE FUNCTION cloud_conversation_owner(p_conversation UUID)
RETURNS TEXT LANGUAGE sql STABLE AS $$
    SELECT COALESCE(
        (SELECT account_id FROM cloud_chat_conversation_members
         WHERE conversation_id = p_conversation AND role = 'owner'
           AND membership_state = 'active'
         ORDER BY joined_at, account_id LIMIT 1),
        (SELECT created_by_account_id FROM cloud_chat_conversations
         WHERE conversation_id = p_conversation)
    );
$$;

-- The organization content owned by p_owner may stay in: p_organization,
-- unless that organization requires member owners and p_owner is not one;
-- then the owner's personal organization.
CREATE OR REPLACE FUNCTION cloud_qualified_organization(p_organization TEXT, p_owner TEXT)
RETURNS TEXT LANGUAGE sql STABLE AS $$
    SELECT CASE
        WHEN p_organization IS NULL THEN NULL
        WHEN NOT EXISTS (
            SELECT 1 FROM cloud_organizations
            WHERE organization_id = p_organization AND member_owned_content
        ) THEN p_organization
        WHEN cloud_is_organization_member(p_organization, p_owner) THEN p_organization
        ELSE cloud_personal_organization(p_owner)
    END;
$$;

-- The group a conversation belongs to: its group space, or for the first
-- conversation of a group, its own session (as channel creation finds it).
CREATE OR REPLACE FUNCTION cloud_conversation_space(
    p_group_space_id TEXT, p_legacy_session_id TEXT, p_conversation UUID
) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
    SELECT COALESCE(p_group_space_id, regexp_replace(
        COALESCE(p_legacy_session_id, p_conversation::text), '^(group:)+', ''
    ));
$$;

-- Refuses an organization the content owner does not belong to, whenever a
-- writer names or changes it.
CREATE OR REPLACE FUNCTION cloud_guard_content_organization()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    content_owner TEXT;
BEGIN
    IF NEW.organization_id IS NULL THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE' THEN
        IF NEW.organization_id IS NOT DISTINCT FROM OLD.organization_id THEN
            RETURN NEW;
        END IF;
    END IF;
    IF TG_TABLE_NAME = 'cloud_chat_conversations' THEN
        -- A new channel joins the organization of its group: the creator is
        -- an active member of a group conversation of the same space there.
        IF TG_OP = 'INSERT' AND NEW.kind = 'group' AND NEW.group_space_id IS NOT NULL
           AND NEW.group_space_id IS DISTINCT FROM NEW.legacy_session_id
           AND EXISTS (
            SELECT 1 FROM cloud_chat_conversations s
            JOIN cloud_chat_conversation_members m
              ON m.conversation_id = s.conversation_id
             AND m.account_id = NEW.created_by_account_id
             AND m.membership_state = 'active'
            WHERE s.organization_id = NEW.organization_id AND s.kind = 'group'
              AND cloud_conversation_space(s.group_space_id, s.legacy_session_id, s.conversation_id)
                  = NEW.group_space_id
        ) THEN
            RETURN NEW;
        END IF;
        IF TG_OP = 'INSERT' THEN
            content_owner := NEW.created_by_account_id;
        ELSE
            content_owner := cloud_conversation_owner(NEW.conversation_id);
        END IF;
    ELSE
        content_owner := NEW.owner_account_id;
    END IF;
    IF NOT cloud_is_organization_member(NEW.organization_id, content_owner) THEN
        RAISE EXCEPTION 'content owner is not a member of the organization'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'organization_member_owner';
    END IF;
    RETURN NEW;
END;
$$;

-- Each guard sorts after the 0163 fill trigger of its table, so it checks
-- the filled value.
DROP TRIGGER IF EXISTS cloud_chat_conversations_organization_member ON cloud_chat_conversations;
CREATE TRIGGER cloud_chat_conversations_organization_member
BEFORE INSERT OR UPDATE OF organization_id ON cloud_chat_conversations
FOR EACH ROW EXECUTE FUNCTION cloud_guard_content_organization();

DROP TRIGGER IF EXISTS cloud_agent_definitions_organization_member ON cloud_agent_definitions;
CREATE TRIGGER cloud_agent_definitions_organization_member
BEFORE INSERT OR UPDATE OF organization_id ON cloud_agent_definitions
FOR EACH ROW EXECUTE FUNCTION cloud_guard_content_organization();

DROP TRIGGER IF EXISTS scheduled_tool_tasks_organization_member ON scheduled_tool_tasks;
CREATE TRIGGER scheduled_tool_tasks_organization_member
BEFORE INSERT OR UPDATE OF organization_id ON scheduled_tool_tasks
FOR EACH ROW EXECUTE FUNCTION cloud_guard_content_organization();

DROP TRIGGER IF EXISTS cloud_attachments_organization_member ON cloud_attachments;
CREATE TRIGGER cloud_attachments_organization_member
BEFORE INSERT OR UPDATE OF organization_id ON cloud_attachments
FOR EACH ROW EXECUTE FUNCTION cloud_guard_content_organization();

-- A new owner of agent, task, or attachment content keeps it in place unless
-- the organization requires member owners.
CREATE OR REPLACE FUNCTION cloud_requalify_content_owner()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.owner_account_id IS DISTINCT FROM OLD.owner_account_id THEN
        NEW.organization_id := cloud_qualified_organization(
            NEW.organization_id, NEW.owner_account_id
        );
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS cloud_agent_definitions_organization_owner ON cloud_agent_definitions;
CREATE TRIGGER cloud_agent_definitions_organization_owner
BEFORE UPDATE OF owner_account_id ON cloud_agent_definitions
FOR EACH ROW EXECUTE FUNCTION cloud_requalify_content_owner();

DROP TRIGGER IF EXISTS scheduled_tool_tasks_organization_owner ON scheduled_tool_tasks;
CREATE TRIGGER scheduled_tool_tasks_organization_owner
BEFORE UPDATE OF owner_account_id ON scheduled_tool_tasks
FOR EACH ROW EXECUTE FUNCTION cloud_requalify_content_owner();

DROP TRIGGER IF EXISTS cloud_attachments_organization_owner ON cloud_attachments;
CREATE TRIGGER cloud_attachments_organization_owner
BEFORE UPDATE OF owner_account_id ON cloud_attachments
FOR EACH ROW EXECUTE FUNCTION cloud_requalify_content_owner();

-- A conversation changes owner when a member gains the owner role.
CREATE OR REPLACE FUNCTION cloud_requalify_conversation_owner()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    UPDATE cloud_chat_conversations c
    SET organization_id = cloud_qualified_organization(c.organization_id, NEW.account_id)
    WHERE c.conversation_id = NEW.conversation_id
      AND c.organization_id IS DISTINCT FROM
          cloud_qualified_organization(c.organization_id, NEW.account_id);
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS cloud_chat_conversation_members_organization_owner
    ON cloud_chat_conversation_members;
CREATE TRIGGER cloud_chat_conversation_members_organization_owner
AFTER INSERT OR UPDATE OF role, membership_state ON cloud_chat_conversation_members
FOR EACH ROW WHEN (NEW.role = 'owner' AND NEW.membership_state = 'active')
EXECUTE FUNCTION cloud_requalify_conversation_owner();

-- Moves content in p_organization whose owner (p_account, or anyone when
-- NULL) does not qualify to the owner's personal organization. Does nothing
-- unless the organization requires member owners. Returns the rows moved.
CREATE OR REPLACE FUNCTION cloud_reassign_ineligible_content(
    p_organization TEXT, p_account TEXT
) RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE
    moved INTEGER := 0;
    step INTEGER;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM cloud_organizations
        WHERE organization_id = p_organization AND member_owned_content
    ) THEN
        RETURN 0;
    END IF;
    UPDATE cloud_chat_conversations c
    SET organization_id = cloud_personal_organization(cloud_conversation_owner(c.conversation_id))
    WHERE c.organization_id = p_organization
      AND (p_account IS NULL OR cloud_conversation_owner(c.conversation_id) = p_account)
      AND NOT cloud_is_organization_member(p_organization, cloud_conversation_owner(c.conversation_id));
    GET DIAGNOSTICS step = ROW_COUNT;
    moved := moved + step;
    UPDATE cloud_agent_definitions d
    SET organization_id = cloud_personal_organization(d.owner_account_id)
    WHERE d.organization_id = p_organization
      AND (p_account IS NULL OR d.owner_account_id = p_account)
      AND NOT cloud_is_organization_member(p_organization, d.owner_account_id);
    GET DIAGNOSTICS step = ROW_COUNT;
    moved := moved + step;
    UPDATE scheduled_tool_tasks t
    SET organization_id = cloud_personal_organization(t.owner_account_id)
    WHERE t.organization_id = p_organization
      AND (p_account IS NULL OR t.owner_account_id = p_account)
      AND NOT cloud_is_organization_member(p_organization, t.owner_account_id);
    GET DIAGNOSTICS step = ROW_COUNT;
    moved := moved + step;
    UPDATE cloud_attachments a
    SET organization_id = cloud_personal_organization(a.owner_account_id)
    WHERE a.organization_id = p_organization
      AND (p_account IS NULL OR a.owner_account_id = p_account)
      AND NOT cloud_is_organization_member(p_organization, a.owner_account_id);
    GET DIAGNOSTICS step = ROW_COUNT;
    RETURN moved + step;
END;
$$;

-- After a member leaves, is removed, expires, or loses the owner role:
-- move content the rule no longer allows (skipped while the account itself
-- is being deleted), and when a team's last owner went, make its
-- longest-standing lasting admin the owner. The organization row is locked
-- first, so this waits for an owner leaving at the same time and then sees
-- the owners that are really left. Teams from the admission file have no
-- owners by design and get none.
CREATE OR REPLACE FUNCTION cloud_after_organization_member_change()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    successor TEXT;
BEGIN
    IF TG_OP = 'DELETE'
       AND EXISTS (SELECT 1 FROM cloud_accounts WHERE account_id = OLD.account_id) THEN
        PERFORM cloud_reassign_ineligible_content(OLD.organization_id, OLD.account_id);
    END IF;
    IF OLD.role <> 'owner' THEN
        RETURN NULL;
    END IF;
    IF TG_OP = 'UPDATE' THEN
        IF NEW.role = 'owner' THEN
            RETURN NULL;
        END IF;
    END IF;
    PERFORM 1 FROM cloud_organizations
    WHERE organization_id = OLD.organization_id AND kind = 'team' AND config_id IS NULL
    FOR UPDATE;
    IF NOT FOUND OR EXISTS (
        SELECT 1 FROM cloud_organization_members
        WHERE organization_id = OLD.organization_id AND role = 'owner'
    ) THEN
        RETURN NULL;
    END IF;
    SELECT account_id INTO successor FROM cloud_organization_members
    WHERE organization_id = OLD.organization_id AND role = 'admin' AND expires_at IS NULL
    ORDER BY joined_at, account_id
    LIMIT 1;
    IF successor IS NOT NULL THEN
        UPDATE cloud_organization_members SET role = 'owner'
        WHERE organization_id = OLD.organization_id AND account_id = successor;
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS cloud_organization_members_after_change ON cloud_organization_members;
CREATE TRIGGER cloud_organization_members_after_change
AFTER DELETE OR UPDATE OF role ON cloud_organization_members
FOR EACH ROW EXECUTE FUNCTION cloud_after_organization_member_change();

-- The organization a run is charged to. A team pays only for work one of its
-- members owns, or requests from a server-run agent.
--
-- 1. A run with a resource pool reservation keeps the organization it was
--    admitted against, so reservation and run always agree.
-- 2. A named personal organization stays when it belongs to the run's owner
--    or requester.
-- 3. A run in a conversation: the writer naming the conversation's own
--    organization (a server-run agent working there) keeps it, a team one
--    only while the conversation qualifies; a team conversation that
--    qualifies also pays when the run's owner is a member. Otherwise the
--    owner's personal organization.
-- 4. A run outside any conversation keeps a named team when its owner or
--    requester is a member. Otherwise the owner's personal organization.
CREATE OR REPLACE FUNCTION cloud_run_organization(
    p_run TEXT, p_session TEXT, p_owner TEXT, p_requester TEXT, p_named TEXT
) RETURNS TEXT LANGUAGE plpgsql STABLE AS $$
DECLARE
    conversation_org TEXT;
    conversation_kind TEXT;
    conversation_owner TEXT;
BEGIN
    IF p_named IS NOT NULL THEN
        IF EXISTS (
            SELECT 1 FROM cloud_resource_pool_reservations
            WHERE run_id = p_run AND organization_id = p_named
        ) THEN
            RETURN p_named;
        END IF;
        IF EXISTS (
            SELECT 1 FROM cloud_organizations
            WHERE organization_id = p_named AND kind = 'personal'
              AND personal_account_id IN (p_owner, p_requester)
        ) THEN
            RETURN p_named;
        END IF;
    END IF;
    SELECT c.organization_id, o.kind, cloud_conversation_owner(c.conversation_id)
    INTO conversation_org, conversation_kind, conversation_owner
    FROM cloud_chat_conversations c
    LEFT JOIN cloud_organizations o ON o.organization_id = c.organization_id
    WHERE c.legacy_session_id = p_session
    LIMIT 1;
    IF FOUND THEN
        IF (conversation_kind = 'personal' AND p_named = conversation_org)
           OR (conversation_kind = 'team'
               AND cloud_qualified_organization(conversation_org, conversation_owner)
                   = conversation_org
               AND (p_named = conversation_org
                    OR cloud_is_organization_member(conversation_org, p_owner))) THEN
            RETURN conversation_org;
        END IF;
        RETURN cloud_personal_organization(p_owner);
    END IF;
    IF p_named IS NOT NULL
       AND (cloud_is_organization_member(p_named, p_owner)
            OR cloud_is_organization_member(p_named, p_requester)) THEN
        RETURN p_named;
    END IF;
    RETURN cloud_personal_organization(p_owner);
END;
$$;

CREATE OR REPLACE FUNCTION cloud_stamp_agent_run_organization()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.organization_id := cloud_run_organization(
        NEW.run_id, NEW.session_id, NEW.owner_account_id, NEW.requester_account_id,
        NEW.organization_id
    );
    RETURN NEW;
END;
$$;

-- A scheduled task run is charged to its task's team while the task owner
-- is a member there and the task qualifies; otherwise to the owner.
CREATE OR REPLACE FUNCTION cloud_stamp_task_run_organization()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.organization_id := COALESCE(
        (SELECT t.organization_id
         FROM scheduled_tool_tasks t
         JOIN cloud_organizations o ON o.organization_id = t.organization_id
         WHERE t.task_id = NEW.task_id
           AND (o.kind = 'personal'
                OR cloud_is_organization_member(t.organization_id, t.owner_account_id))),
        cloud_personal_organization(NEW.owner_account_id)
    );
    RETURN NEW;
END;
$$;

-- Replace the 0163 fill triggers of the run tables: stamp when queued, and
-- re-check when a run is leased or starts.
DROP TRIGGER IF EXISTS cloud_agent_fallback_runs_organization ON cloud_agent_fallback_runs;
CREATE TRIGGER cloud_agent_fallback_runs_organization
BEFORE INSERT ON cloud_agent_fallback_runs
FOR EACH ROW EXECUTE FUNCTION cloud_stamp_agent_run_organization();

DROP TRIGGER IF EXISTS cloud_agent_fallback_runs_organization_start ON cloud_agent_fallback_runs;
CREATE TRIGGER cloud_agent_fallback_runs_organization_start
BEFORE UPDATE OF status ON cloud_agent_fallback_runs
FOR EACH ROW
WHEN (NEW.status IN ('leased', 'running') AND OLD.status IS DISTINCT FROM NEW.status)
EXECUTE FUNCTION cloud_stamp_agent_run_organization();

DROP TRIGGER IF EXISTS scheduled_tool_task_runs_organization ON scheduled_tool_task_runs;
CREATE TRIGGER scheduled_tool_task_runs_organization
BEFORE INSERT ON scheduled_tool_task_runs
FOR EACH ROW EXECUTE FUNCTION cloud_stamp_task_run_organization();

DROP TRIGGER IF EXISTS scheduled_tool_task_runs_organization_start ON scheduled_tool_task_runs;
CREATE TRIGGER scheduled_tool_task_runs_organization_start
BEFORE UPDATE OF status ON scheduled_tool_task_runs
FOR EACH ROW
WHEN (NEW.status IN ('leased', 'running') AND OLD.status IS DISTINCT FROM NEW.status)
EXECUTE FUNCTION cloud_stamp_task_run_organization();
