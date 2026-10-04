-- Persistent verification state for each account's primary email.
--
-- OAuth sign-in links a provider identity into an existing account by email
-- only when that account's primary email is itself verified. Password signup
-- does not prove email ownership, so password-only accounts start unverified.
-- An account counts as verified when an identity linked to it carries the same
-- email and the provider reported that email as verified.

ALTER TABLE cloud_accounts
    ADD COLUMN IF NOT EXISTS primary_email_verified_at TEXT;

UPDATE cloud_accounts AS account
SET primary_email_verified_at = (
    SELECT MIN(identity.created_at)
    FROM cloud_account_identities AS identity
    WHERE identity.account_id = account.account_id
      AND identity.email_verified
      AND identity.email IS NOT NULL
      AND LOWER(identity.email) = LOWER(account.primary_email)
)
WHERE account.primary_email IS NOT NULL
  AND account.primary_email_verified_at IS NULL
  AND EXISTS (
      SELECT 1
      FROM cloud_account_identities AS identity
      WHERE identity.account_id = account.account_id
        AND identity.email_verified
        AND identity.email IS NOT NULL
        AND LOWER(identity.email) = LOWER(account.primary_email)
  );
