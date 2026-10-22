-- Ten colour designs join the six kind designs a profile card may use.
-- 0144 declared the check inline, so it carries Postgres's default name.

ALTER TABLE cloud_common_ground_profiles
    DROP CONSTRAINT IF EXISTS cloud_common_ground_profiles_design_check;

ALTER TABLE cloud_common_ground_profiles
    ADD CONSTRAINT cloud_common_ground_profiles_design_check
    CHECK (design IS NULL OR design IN (
        'work', 'health', 'daily', 'workshop', 'research', 'custom',
        'ocean', 'sky', 'rose', 'coral', 'amber', 'forest', 'lavender', 'graphite', 'mint', 'olive'
    ));
