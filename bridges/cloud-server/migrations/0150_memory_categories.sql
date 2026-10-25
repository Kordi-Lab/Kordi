-- Memories gain an HCP category (what kind of information a memory is), a
-- declaration type (said by the person or inferred by an agent), a
-- confidence for inferred memories, and an optional profile the person filed
-- the memory to (#1977). Old rows are backfilled from their source.

ALTER TABLE cloud_account_memories
    ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'general_preferences'
        CONSTRAINT cloud_account_memories_category_check
        CHECK (category IN ('general_preferences', 'goals_and_constraints',
            'health_context', 'education_learner_profile', 'work_context',
            'purchase_history_preferences', 'values_and_ethics',
            'location_context', 'coordination_context', 'hcp-custom:task_lessons'));

ALTER TABLE cloud_account_memories
    ADD COLUMN IF NOT EXISTS declaration_type TEXT NOT NULL DEFAULT 'model-inferred'
        CONSTRAINT cloud_account_memories_declaration_type_check
        CHECK (declaration_type IN ('user-declared', 'model-inferred'));

ALTER TABLE cloud_account_memories
    ADD COLUMN IF NOT EXISTS confidence TEXT NULL
        CONSTRAINT cloud_account_memories_confidence_check
        CHECK (confidence IN ('low', 'medium', 'high'));

-- Deleting a profile leaves its memories in place, routed by category again.
ALTER TABLE cloud_account_memories
    ADD COLUMN IF NOT EXISTS profile_id TEXT NULL
        REFERENCES cloud_common_ground_profiles(profile_id) ON DELETE SET NULL;

-- Memories typed by the person are user-declared; every other source came
-- from an agent and is inferred with medium confidence. Task lessons keep
-- their own category.
UPDATE cloud_account_memories SET declaration_type = 'user-declared', confidence = NULL
    WHERE source = 'manual';
UPDATE cloud_account_memories SET declaration_type = 'model-inferred', confidence = 'medium'
    WHERE source <> 'manual' AND confidence IS NULL;
UPDATE cloud_account_memories SET category = 'hcp-custom:task_lessons'
    WHERE source IN ('repeated_failure', 'outcome')
      AND category = 'general_preferences';

CREATE INDEX IF NOT EXISTS cloud_account_memories_owner_category_idx
    ON cloud_account_memories (owner_account_id, category)
    WHERE archived_at IS NULL;
