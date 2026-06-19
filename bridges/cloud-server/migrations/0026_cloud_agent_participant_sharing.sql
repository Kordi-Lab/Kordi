ALTER TABLE cloud_agent_definitions
    DROP CONSTRAINT IF EXISTS cloud_agent_definitions_access_scope_check;

ALTER TABLE cloud_agent_definitions
    ADD CONSTRAINT cloud_agent_definitions_access_scope_check
        CHECK (access_scope IN ('private', 'participant_conversations'));
