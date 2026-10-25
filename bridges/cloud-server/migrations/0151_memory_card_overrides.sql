-- A memory may feed several Grounding cards (#2035). A memory's cards are
-- the owner's profiles its category routes to, minus the cards with an
-- `included = false` row here, plus the cards with an `included = true` row.
-- The `profile_id` column of cloud_account_memories stays for older code and
-- equals the single included card when there is exactly one.

CREATE TABLE IF NOT EXISTS cloud_account_memory_card_overrides (
    memory_id TEXT NOT NULL
        REFERENCES cloud_account_memories(memory_id) ON DELETE CASCADE,
    profile_id TEXT NOT NULL
        REFERENCES cloud_common_ground_profiles(profile_id) ON DELETE CASCADE,
    included BOOLEAN NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (memory_id, profile_id)
);

CREATE INDEX IF NOT EXISTS cloud_account_memory_card_overrides_profile_idx
    ON cloud_account_memory_card_overrides (profile_id, memory_id);

-- A pinned memory fed only its pinned card, so it keeps doing so: one
-- included row for the pin and an excluded row for every other card of the
-- owner its category routes to. Group memories never had cards.
INSERT INTO cloud_account_memory_card_overrides (memory_id, profile_id, included)
SELECT memory_id, profile_id, TRUE
FROM cloud_account_memories
WHERE profile_id IS NOT NULL AND scope <> 'group'
ON CONFLICT (memory_id, profile_id) DO NOTHING;

INSERT INTO cloud_account_memory_card_overrides (memory_id, profile_id, included)
SELECT memory.memory_id, profile.profile_id, FALSE
FROM cloud_account_memories memory
JOIN cloud_common_ground_profiles profile
    ON profile.account_id = memory.owner_account_id
   AND profile.profile_id <> memory.profile_id
WHERE memory.profile_id IS NOT NULL AND memory.scope <> 'group'
  AND profile.kind IN ('work', 'health', 'daily')
  AND (CASE memory.category
        WHEN 'work_context' THEN 'work'
        WHEN 'education_learner_profile' THEN 'work'
        WHEN 'health_context' THEN 'health'
        WHEN 'location_context' THEN 'daily'
        WHEN 'purchase_history_preferences' THEN 'daily'
        WHEN 'coordination_context' THEN 'all'
      END) IN (profile.kind, 'all')
ON CONFLICT (memory_id, profile_id) DO NOTHING;
