-- Provider identities keep the email they may be matched by
-- (docs/development/organization-admission.md, "Verified provider emails").
-- A provider email that changes or stops being verified keeps its link to the
-- account but is no longer used as evidence until it is verified again.
SET LOCAL lock_timeout = '5s';

ALTER TABLE cloud_account_identities
    ADD COLUMN IF NOT EXISTS matching_email TEXT;

-- Existing identities keep matching by the email their provider verified.
UPDATE cloud_account_identities
SET matching_email = LOWER(TRIM(email))
WHERE matching_email IS NULL
  AND email_verified
  AND email IS NOT NULL
  AND TRIM(email) <> '';
