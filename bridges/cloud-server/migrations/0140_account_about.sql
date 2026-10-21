-- A short line the account owner writes about themselves (#1945), shown on
-- their contact profile. NULL when they have not written one.

ALTER TABLE cloud_accounts
    ADD COLUMN IF NOT EXISTS about TEXT NULL;
