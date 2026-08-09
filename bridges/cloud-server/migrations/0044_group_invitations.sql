-- Group invitation links are bearer invitations to a preview, never direct
-- membership capabilities. Membership becomes active only after an
-- authenticated account explicitly accepts the invitation.

CREATE TABLE IF NOT EXISTS cloud_group_invitations (
    invitation_id      TEXT PRIMARY KEY,
    inviter_account_id TEXT NOT NULL
        REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    token_hash         TEXT NOT NULL UNIQUE,
    group_id           TEXT NOT NULL,
    group_space_id     TEXT NOT NULL,
    group_title        TEXT NOT NULL,
    group_snapshot     JSONB NOT NULL,
    created_at         TEXT NOT NULL,
    expires_at         TEXT NOT NULL,
    revoked_at         TEXT
);

CREATE INDEX IF NOT EXISTS idx_cloud_group_invitations_inviter
    ON cloud_group_invitations(inviter_account_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_cloud_group_invitations_group
    ON cloud_group_invitations(inviter_account_id, group_space_id, created_at DESC);

CREATE TABLE IF NOT EXISTS cloud_group_invitation_acceptances (
    invitation_id TEXT NOT NULL
        REFERENCES cloud_group_invitations(invitation_id) ON DELETE CASCADE,
    account_id    TEXT NOT NULL
        REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    accepted_at   TEXT NOT NULL,
    PRIMARY KEY (invitation_id, account_id)
);

CREATE INDEX IF NOT EXISTS idx_cloud_group_invitation_acceptances_account
    ON cloud_group_invitation_acceptances(account_id, accepted_at DESC);
