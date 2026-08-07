-- Migration 36: public identity remains separate from the canonical account_id used by
-- storage and protocols. The allocator uses a transaction-scoped advisory
-- lock so concurrent signups cannot choose the same nine-digit number.

ALTER TABLE cloud_accounts
    ADD COLUMN IF NOT EXISTS public_account_number BIGINT;

CREATE OR REPLACE FUNCTION kordi_allocate_public_account_number()
RETURNS BIGINT
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
    candidate BIGINT;
BEGIN
    LOOP
        candidate := FLOOR(random() * 900000000)::BIGINT + 100000000;
        PERFORM pg_advisory_xact_lock(candidate);
        IF NOT EXISTS (
            SELECT 1
            FROM cloud_accounts
            WHERE public_account_number = candidate
        ) THEN
            RETURN candidate;
        END IF;
    END LOOP;
END;
$$;

DO $$
DECLARE
    account_row RECORD;
BEGIN
    FOR account_row IN
        SELECT account_id
        FROM cloud_accounts
        WHERE public_account_number IS NULL
        ORDER BY account_id
    LOOP
        UPDATE cloud_accounts
        SET public_account_number = kordi_allocate_public_account_number()
        WHERE account_id = account_row.account_id;
    END LOOP;
END;
$$;

ALTER TABLE cloud_accounts
    ALTER COLUMN public_account_number SET DEFAULT kordi_allocate_public_account_number(),
    ALTER COLUMN public_account_number SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_accounts_public_account_number
    ON cloud_accounts(public_account_number);

ALTER TABLE cloud_accounts
    DROP CONSTRAINT IF EXISTS cloud_accounts_public_account_number_range;

ALTER TABLE cloud_accounts
    ADD CONSTRAINT cloud_accounts_public_account_number_range
    CHECK (public_account_number BETWEEN 100000000 AND 999999999);

CREATE TABLE IF NOT EXISTS cloud_app_invitations (
    invitation_id      TEXT PRIMARY KEY,
    inviter_account_id TEXT NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    token_hash         TEXT NOT NULL UNIQUE,
    created_at         TEXT NOT NULL,
    expires_at         TEXT NOT NULL,
    revoked_at         TEXT
);

CREATE INDEX IF NOT EXISTS idx_cloud_app_invitations_inviter
    ON cloud_app_invitations(inviter_account_id, created_at DESC);
