-- Account profile fields an owner may fill in, all optional. A parallel
-- change may add `about` on its own, so every column uses IF NOT EXISTS.
-- `birthday` is shown only to the owner.

ALTER TABLE cloud_accounts ADD COLUMN IF NOT EXISTS about TEXT NULL;
ALTER TABLE cloud_accounts ADD COLUMN IF NOT EXISTS location TEXT NULL;
ALTER TABLE cloud_accounts ADD COLUMN IF NOT EXISTS time_zone TEXT NULL;
ALTER TABLE cloud_accounts ADD COLUMN IF NOT EXISTS website TEXT NULL;
ALTER TABLE cloud_accounts ADD COLUMN IF NOT EXISTS birthday DATE NULL;

-- When the public handle last changed; a handle may change once a year.
ALTER TABLE cloud_accounts ADD COLUMN IF NOT EXISTS public_handle_changed_at TIMESTAMPTZ NULL;
