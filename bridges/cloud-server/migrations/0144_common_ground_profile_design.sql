-- The card design a profile shows in the apps' wallet, synced across the
-- owner's devices. NULL means the kind's default design.

ALTER TABLE cloud_common_ground_profiles
    ADD COLUMN IF NOT EXISTS design TEXT NULL
    CHECK (design IS NULL OR design IN ('work', 'health', 'daily', 'workshop', 'research', 'custom'));
