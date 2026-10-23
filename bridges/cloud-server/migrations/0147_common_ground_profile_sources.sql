-- The sources a profile's card is built from, synced across the owner's
-- devices: memory, connectors, device data, agent files, Kordi documents,
-- links and notes. Only the owner sees them. NULL means never saved.

ALTER TABLE cloud_common_ground_profiles
    ADD COLUMN IF NOT EXISTS sources_json JSONB NULL;
