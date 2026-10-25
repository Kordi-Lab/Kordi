-- Agents may use the original `kordi-birds` avatar style beside DiceBear `thumbs`.
-- Existing rows are unchanged; `thumbs` stays valid so stored avatar URLs keep
-- rendering. People keep Lorelei only (cloud_accounts is not touched).

ALTER TABLE cloud_agent_definitions
    DROP CONSTRAINT IF EXISTS cloud_agent_definitions_avatar_style_check,
    ADD CONSTRAINT cloud_agent_definitions_avatar_style_check
        CHECK (avatar_style IN ('thumbs', 'kordi-birds'));

ALTER TABLE cloud_default_agent_profiles
    DROP CONSTRAINT IF EXISTS cloud_default_agent_profiles_avatar_style_check,
    ADD CONSTRAINT cloud_default_agent_profiles_avatar_style_check
        CHECK (avatar_style IN ('thumbs', 'kordi-birds'));

-- Created inline (unnamed) in 0061, so PostgreSQL named it <table>_<column>_check.
ALTER TABLE cloud_avatar_render_keys
    DROP CONSTRAINT IF EXISTS cloud_avatar_render_keys_style_check,
    ADD CONSTRAINT cloud_avatar_render_keys_style_check
        CHECK (style IN ('lorelei', 'thumbs', 'kordi-birds'));
