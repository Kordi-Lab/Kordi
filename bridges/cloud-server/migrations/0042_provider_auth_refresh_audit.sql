ALTER TABLE cloud_agent_provider_auth_snapshot_audit
    DROP CONSTRAINT IF EXISTS cloud_agent_provider_auth_snapshot_audit_action_check;

ALTER TABLE cloud_agent_provider_auth_snapshot_audit
    ADD CONSTRAINT cloud_agent_provider_auth_snapshot_audit_action_check
    CHECK (action IN ('created', 'used', 'refreshed', 'revoked'));
