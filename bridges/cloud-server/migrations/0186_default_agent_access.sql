-- Access for each account's default Kordi agent (docs/contact-permissions.md).
--
-- The default agent has the same Access setting as a Factory agent. NULL, or
-- a missing profile row, means `participant_conversations`: people in the
-- owner's chats can use it. `private` means only the owner can.
SET LOCAL lock_timeout = '5s';

ALTER TABLE cloud_default_agent_profiles
    ADD COLUMN IF NOT EXISTS access_scope TEXT;

ALTER TABLE cloud_default_agent_profiles
    DROP CONSTRAINT IF EXISTS cloud_default_agent_profiles_access_scope_check;

ALTER TABLE cloud_default_agent_profiles
    ADD CONSTRAINT cloud_default_agent_profiles_access_scope_check
        CHECK (access_scope IS NULL OR access_scope IN ('private', 'participant_conversations'));
