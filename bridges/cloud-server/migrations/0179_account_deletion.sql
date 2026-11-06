-- Account deletion (docs/development/account-deletion.md).
--
-- Deleting a cloud_accounts row cascades to almost everything the account
-- owns. These foreign keys blocked it, and nothing of the account should
-- outlive it there:
--
--   cloud_project_devices, cloud_project_commands   the account's Macs
--   cloud_agent_exchanges                            agent-to-agent calls of
--                                                    a deleted account or run
--   cloud_agent_fallback_runs.parent_run_id,         another person's run
--   .subsession_id                                   keeps going without them
--   cloud_agent_subsession_chat.run_id               a kept request loses the
--                                                    deleted run it named
--
-- Conversations, messages, plan cards and agent-session requests that other
-- people keep are moved to the Deleted account stand-in by the server
-- before the account row is deleted; their foreign keys stay as they are,
-- so a row the server missed fails the deletion instead of vanishing.
--
-- cloud_object_deletions queues object-store keys of deleted uploads and
-- avatars. Rows are written in the deletion's transaction and removed once
-- the object is gone, so a failed or interrupted delete is retried.
SET LOCAL lock_timeout = '5s';

ALTER TABLE cloud_project_devices
    DROP CONSTRAINT IF EXISTS cloud_project_devices_account_id_fkey,
    ADD CONSTRAINT cloud_project_devices_account_id_fkey
        FOREIGN KEY (account_id) REFERENCES cloud_accounts (account_id) ON DELETE CASCADE,
    DROP CONSTRAINT IF EXISTS cloud_project_devices_device_id_fkey,
    ADD CONSTRAINT cloud_project_devices_device_id_fkey
        FOREIGN KEY (device_id) REFERENCES cloud_devices (device_id) ON DELETE CASCADE;

ALTER TABLE cloud_project_commands
    DROP CONSTRAINT IF EXISTS cloud_project_commands_account_id_fkey,
    ADD CONSTRAINT cloud_project_commands_account_id_fkey
        FOREIGN KEY (account_id) REFERENCES cloud_accounts (account_id) ON DELETE CASCADE,
    DROP CONSTRAINT IF EXISTS cloud_project_commands_device_id_fkey,
    ADD CONSTRAINT cloud_project_commands_device_id_fkey
        FOREIGN KEY (device_id) REFERENCES cloud_devices (device_id) ON DELETE CASCADE;

ALTER TABLE cloud_agent_exchanges
    DROP CONSTRAINT IF EXISTS cloud_agent_exchanges_target_owner_id_fkey,
    ADD CONSTRAINT cloud_agent_exchanges_target_owner_id_fkey
        FOREIGN KEY (target_owner_id) REFERENCES cloud_accounts (account_id) ON DELETE CASCADE,
    DROP CONSTRAINT IF EXISTS cloud_agent_exchanges_parent_run_id_fkey,
    ADD CONSTRAINT cloud_agent_exchanges_parent_run_id_fkey
        FOREIGN KEY (parent_run_id) REFERENCES cloud_agent_fallback_runs (run_id)
        ON DELETE CASCADE,
    DROP CONSTRAINT IF EXISTS cloud_agent_exchanges_root_run_id_fkey,
    ADD CONSTRAINT cloud_agent_exchanges_root_run_id_fkey
        FOREIGN KEY (root_run_id) REFERENCES cloud_agent_fallback_runs (run_id)
        ON DELETE CASCADE,
    DROP CONSTRAINT IF EXISTS cloud_agent_exchanges_target_run_id_fkey,
    ADD CONSTRAINT cloud_agent_exchanges_target_run_id_fkey
        FOREIGN KEY (target_run_id) REFERENCES cloud_agent_fallback_runs (run_id)
        ON DELETE CASCADE,
    DROP CONSTRAINT IF EXISTS cloud_agent_exchanges_resume_run_id_fkey,
    ADD CONSTRAINT cloud_agent_exchanges_resume_run_id_fkey
        FOREIGN KEY (resume_run_id) REFERENCES cloud_agent_fallback_runs (run_id)
        ON DELETE CASCADE;

ALTER TABLE cloud_agent_fallback_runs
    DROP CONSTRAINT IF EXISTS cloud_agent_fallback_runs_parent_run_id_fkey,
    ADD CONSTRAINT cloud_agent_fallback_runs_parent_run_id_fkey
        FOREIGN KEY (parent_run_id) REFERENCES cloud_agent_fallback_runs (run_id)
        ON DELETE SET NULL,
    DROP CONSTRAINT IF EXISTS cloud_agent_fallback_runs_subsession_id_fkey,
    ADD CONSTRAINT cloud_agent_fallback_runs_subsession_id_fkey
        FOREIGN KEY (subsession_id) REFERENCES cloud_agent_subsessions (subsession_id)
        ON DELETE SET NULL;

ALTER TABLE cloud_agent_subsession_chat
    DROP CONSTRAINT IF EXISTS cloud_agent_subsession_chat_run_id_fkey,
    ADD CONSTRAINT cloud_agent_subsession_chat_run_id_fkey
        FOREIGN KEY (run_id) REFERENCES cloud_agent_fallback_runs (run_id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS cloud_object_deletions (
    object_key      TEXT PRIMARY KEY,
    queued_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    attempts        INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_error      TEXT
);

CREATE INDEX IF NOT EXISTS idx_cloud_object_deletions_due
    ON cloud_object_deletions (next_attempt_at);
