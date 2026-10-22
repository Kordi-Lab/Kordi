-- The icon a profile shows on its card in the apps, synced across the
-- owner's devices. NULL means the card shows no icon.

ALTER TABLE cloud_common_ground_profiles
    ADD COLUMN IF NOT EXISTS icon TEXT NULL
    CHECK (icon IS NULL OR icon IN (
        'briefcase', 'leaf', 'sun', 'flask', 'book', 'microscope', 'graduation', 'pin', 'star',
        'heart', 'chat', 'globe', 'music', 'camera', 'code', 'calendar', 'rocket', 'coffee'
    ));
