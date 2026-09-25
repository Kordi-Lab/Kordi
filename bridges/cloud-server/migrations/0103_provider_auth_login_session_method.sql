-- The sign-in method a provider login used ("default" or "api-key"), kept so
-- saved accounts can later be labelled by how they were added.
ALTER TABLE cloud_agent_provider_login_sessions
    ADD COLUMN IF NOT EXISTS method TEXT NOT NULL DEFAULT 'default';
