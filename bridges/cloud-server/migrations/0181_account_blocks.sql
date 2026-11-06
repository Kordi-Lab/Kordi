-- Account blocks.
--
-- A row means `blocker_account_id` blocked `blocked_account_id`. The list is
-- private to the blocker and the blocked account is never told. While a block
-- exists in either direction the two accounts cannot be contacts, send each
-- other contact requests, write in a direct conversation together, add each
-- other to groups, join a group through the other's invite link, or call
-- each other. Shared groups keep both members; the blocker gets no push
-- notifications for the blocked account's messages there.
--
-- Deleting either account deletes its blocks.

CREATE TABLE IF NOT EXISTS cloud_account_blocks (
    blocker_account_id TEXT NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    blocked_account_id TEXT NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (blocker_account_id, blocked_account_id),
    CHECK (blocker_account_id <> blocked_account_id)
);

CREATE INDEX IF NOT EXISTS idx_cloud_account_blocks_blocked
    ON cloud_account_blocks (blocked_account_id, blocker_account_id);

-- Function parameters use a `p_` prefix because column names take
-- precedence over parameter names inside SQL functions.
CREATE OR REPLACE FUNCTION cloud_accounts_blocked_either_way(p_a TEXT, p_b TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1 FROM cloud_account_blocks x
        WHERE (x.blocker_account_id = p_a AND x.blocked_account_id = p_b)
           OR (x.blocker_account_id = p_b AND x.blocked_account_id = p_a))
$$;
