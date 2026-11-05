-- The organization a session acts in (docs/development/organization-requests.md).
-- Additive only. An empty claim means the account's personal organization,
-- so sessions issued before this migration keep working unchanged.
--
-- A session row carries the organization of its access token. A browser
-- sign-in remembers the organization its next access tokens get, so a
-- refresh keeps the organization the app last switched to. Deleting an
-- organization empties the claim, which falls back to the personal one.
ALTER TABLE cloud_refresh_tokens
    ADD COLUMN IF NOT EXISTS organization_id TEXT
        REFERENCES cloud_organizations(organization_id) ON DELETE SET NULL;

ALTER TABLE cloud_app_sign_ins
    ADD COLUMN IF NOT EXISTS organization_id TEXT
        REFERENCES cloud_organizations(organization_id) ON DELETE SET NULL;

-- Deleting an organization nulls these columns; the partial indexes keep
-- that cheap without indexing the many rows that never switch.
CREATE INDEX IF NOT EXISTS idx_cloud_refresh_tokens_organization
    ON cloud_refresh_tokens (organization_id)
    WHERE organization_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_cloud_app_sign_ins_organization
    ON cloud_app_sign_ins (organization_id)
    WHERE organization_id IS NOT NULL;
