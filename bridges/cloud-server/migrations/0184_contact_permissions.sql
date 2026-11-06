-- Per-person permissions (docs/contact-permissions.md).
--
-- An owner may stop one other account from using the owner's agents
-- (`agent_access`) or from seeing the owner's Grounding card
-- (`card_access`). A missing row means both are allowed. Rows are keyed by
-- account, not by contact, so removing and re-adding a contact keeps them.
-- They are one-directional: a row restricts only `subject_account_id`.
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS cloud_contact_permissions (
    owner_account_id TEXT NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    subject_account_id TEXT NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    agent_access BOOLEAN NOT NULL DEFAULT TRUE,
    card_access BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (owner_account_id, subject_account_id),
    CHECK (owner_account_id <> subject_account_id)
);

-- Checks run from the subject's side ("who restricts this account").
CREATE INDEX IF NOT EXISTS idx_cloud_contact_permissions_subject
    ON cloud_contact_permissions (subject_account_id, owner_account_id);
