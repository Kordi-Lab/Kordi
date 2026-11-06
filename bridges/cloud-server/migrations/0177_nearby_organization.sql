-- The organization Nearby work is charged to (docs/development/resource-pools.md).
-- Additive only. A request records the organization its creator acted in, and
-- the Nearby setting records the one Nearby was turned on in, so request
-- checks and match alerts queued later by the sweep use that organization's
-- resource pool rather than whichever one is selected then. An empty value
-- means the account's personal organization, so rows from before this
-- migration keep using the personal pool. Deleting an organization empties it.
ALTER TABLE cloud_common_ground_nearby
    ADD COLUMN IF NOT EXISTS organization_id TEXT
        REFERENCES cloud_organizations(organization_id) ON DELETE SET NULL;

ALTER TABLE cloud_common_ground_nearby_needs
    ADD COLUMN IF NOT EXISTS organization_id TEXT
        REFERENCES cloud_organizations(organization_id) ON DELETE SET NULL;

-- Deleting an organization nulls these columns; the partial indexes keep
-- that cheap without indexing rows that stay personal.
CREATE INDEX IF NOT EXISTS idx_cloud_common_ground_nearby_organization
    ON cloud_common_ground_nearby (organization_id)
    WHERE organization_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_cloud_common_ground_nearby_needs_organization
    ON cloud_common_ground_nearby_needs (organization_id)
    WHERE organization_id IS NOT NULL;
