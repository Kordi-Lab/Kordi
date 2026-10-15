-- Digest runs were queued without an account, which only resolves while the
-- owner holds exactly one saved provider account (issue 1795). Digests that
-- failed with missing_provider_auth while the owner held a saved account
-- retry once now that each run names its account.

UPDATE cloud_account_digests d
SET retry_after = now(),
    failure_count = 0,
    dirty_since = COALESCE(d.dirty_since, now())
WHERE d.error_code = 'missing_provider_auth'
  AND d.active_run_id IS NULL
  AND EXISTS (
      SELECT 1 FROM cloud_agent_provider_auth_snapshots s
      WHERE s.account_id = d.account_id AND s.revoked_at IS NULL
  );
