-- Desktop sign-in copies saved before the readiness columns existed carry only
-- an access token and no expiry, so they counted as ready forever and kept
-- serving expired tokens to cloud runs (issue 1802). The server cannot refresh
-- them, so they are marked as needing reconnect; the desktop republishes a
-- current copy on its next sync.

UPDATE cloud_agent_provider_auth_snapshots
SET expires_at_ms = 0
WHERE revoked_at IS NULL
  AND expires_at_ms IS NULL
  AND refreshable = FALSE
  AND auth_choice = 'local-active-oauth';
