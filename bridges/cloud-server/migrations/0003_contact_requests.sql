-- Approval-gated contact flow.
--
-- Until now, `cloud_contacts` had no notion of consent — anyone could
-- add anyone. That worked for the WS gateway smoke test but isn't a
-- real product surface. This migration adds a request inbox so a user
-- (the requester) sends a request, and the recipient decides whether
-- to accept or reject. Accepting populates `cloud_contacts` for both
-- sides; rejecting just records the decision.
--
-- `cloud_contacts` itself is unchanged — rows there always mean "this
-- side has agreed to see this peer." Whether the relationship is
-- mutual is determined by whether both directional rows exist.

CREATE TABLE IF NOT EXISTS cloud_contact_requests (
    request_id      TEXT PRIMARY KEY,
    from_account_id TEXT NOT NULL
        REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    to_account_id   TEXT NOT NULL
        REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    status          TEXT NOT NULL DEFAULT 'pending',
    message         TEXT,
    created_at      TEXT NOT NULL,
    decided_at      TEXT,
    CHECK (status IN ('pending', 'accepted', 'rejected')),
    CHECK (from_account_id <> to_account_id)
);

-- At most one outstanding pending request between any ordered (from, to)
-- pair. Decided requests don't block a re-request.
CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_contact_requests_pending_unique
    ON cloud_contact_requests (from_account_id, to_account_id)
    WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_cloud_contact_requests_to_pending
    ON cloud_contact_requests (to_account_id, created_at)
    WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_cloud_contact_requests_from
    ON cloud_contact_requests (from_account_id, created_at);
