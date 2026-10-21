-- Account handles: an optional, user-chosen public Kordi ID such as
-- `shuyhere`. When it is unset the nine-digit public account number stays the
-- visible Kordi ID. The handle must contain a letter so it can never collide
-- with a nine-digit number, and it is unique regardless of case.

ALTER TABLE cloud_accounts ADD COLUMN IF NOT EXISTS public_handle TEXT;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'cloud_accounts_public_handle_format'
    ) THEN
        ALTER TABLE cloud_accounts
            ADD CONSTRAINT cloud_accounts_public_handle_format
            CHECK (
                public_handle IS NULL
                OR (public_handle ~ '^[A-Za-z0-9]{3,30}$' AND public_handle ~ '[A-Za-z]')
            );
    END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_accounts_public_handle_lower
    ON cloud_accounts (LOWER(public_handle))
    WHERE public_handle IS NOT NULL;
