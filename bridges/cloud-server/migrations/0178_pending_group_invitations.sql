-- A group invitation an account claimed on the web, so the app can offer to
-- join it after sign-in, on launch, or after a reinstall. Claiming never adds
-- the account to the group; joining still goes through the invitation.
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS cloud_pending_group_invitations (
    pending_id    TEXT PRIMARY KEY,
    account_id    TEXT NOT NULL
        REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    invitation_id TEXT NOT NULL
        REFERENCES cloud_group_invitations(invitation_id) ON DELETE CASCADE,
    created_at    TEXT NOT NULL,
    dismissed_at  TEXT,
    consumed_at   TEXT,
    UNIQUE (account_id, invitation_id)
);

CREATE INDEX IF NOT EXISTS idx_cloud_pending_group_invitations_live
    ON cloud_pending_group_invitations(account_id, created_at DESC)
    WHERE dismissed_at IS NULL AND consumed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_cloud_pending_group_invitations_invitation
    ON cloud_pending_group_invitations(invitation_id);
