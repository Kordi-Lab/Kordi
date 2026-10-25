-- A card build relates the owner's other memories to the card (#2069).
-- `build_candidates_json` holds the ids of the memories the run was offered
-- until it finishes, so only those can be added to the card.
ALTER TABLE cloud_common_ground_cards ADD COLUMN IF NOT EXISTS build_candidates_json JSONB;
