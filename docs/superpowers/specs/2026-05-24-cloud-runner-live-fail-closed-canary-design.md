# Cloud Runner Fail-Closed Live Queue Canary Design

## Parent

- Parent issue: #479 offline Cloud agent fallback
- Runtime umbrella: #494 Cloud sandbox fallback runtime
- Prior slice: #511/#512 manual idle Cloud runner canary deployment
- This slice: #513 fail-closed live queue canary

## Goal

Add a manual, confirmation-gated K3s canary that temporarily lets the Cloud Agent Runner poll the live queue for exactly one controlled fallback run that has no provider-auth snapshot. The expected outcome is a failed run with `missing_provider_auth`, no model call, no response placeholder, no artifact rows, and the runner restored to idle/off state.

## Non-goals

- No real model/provider call.
- No always-on runner.
- No automatic production rollout.
- No UI changes.
- No merge before user testing.

## Design

### Canary script

Add `bridges/cloud-agent-runner/scripts/k8s-runner-live-fail-closed-canary.sh`.

The script is intentionally operator-only:

1. Requires `CONFIRM_KORDI_RUNNER_LIVE_CANARY=1`.
2. Requires the runner Deployment to start at `replicas=0`.
3. Requires the Deployment template to start with `KORDI_CLOUD_RUNNER_CANARY_IDLE=1`.
4. Refuses to run if any pre-existing fallback runs are in `queued`, `leased`, or `running` status.
5. Seeds exactly one controlled canary run directly into Postgres using unique canary account/session/sandbox/run ids.
6. Verifies the canary owner has no provider-auth snapshots.
7. Temporarily sets `KORDI_CLOUD_RUNNER_CANARY_IDLE=0` and scales the runner to 1.
8. Waits until the canary run reaches `failed` with `missing_provider_auth`.
9. Verifies no response message id and zero artifact rows for that run.
10. Restores `KORDI_CLOUD_RUNNER_CANARY_IDLE=1`, scales runner to 0, and waits until no runner pods remain.

### Why direct Postgres seeding

The goal is canarying the runner queue-consumer path, not retesting user signup/contact/presence claim flows. Direct SQL seeding lets the script create a self-contained controlled run without needing user credentials or modifying production user data. The script uses unique canary ids and only inserts the minimum rows required by foreign keys:

- `cloud_accounts` owner/requester
- `cloud_agent_sandboxes` sandbox metadata
- `cloud_agent_fallback_runs` queued run

No provider-auth snapshot is inserted for the canary owner.

### Safety controls

- The script refuses to run when active non-canary queued/leased/running runs exist.
- The runner can process only the single seeded run because the active-run precheck is zero before insertion.
- Missing provider auth is detected before `mark_running` and before sandbox/model execution.
- The canary does not use model credentials and does not call external model APIs.
- Cleanup runs through `trap` and restores idle mode/zero replicas on exit.

### Verification

Local tests:

- Static script test verifies confirmation gate, idle-mode patch down/up, scale down, active-run precheck, and `missing_provider_auth` assertion.
- Existing runner tests continue to prove missing provider auth fails before running/model calls.

Remote K3s canary verifies:

- preflight sees `replicas=0` and idle mode `1`
- one canary run is inserted
- runner polls after idle mode is set to `0`
- run fails with `missing_provider_auth`
- `response_message_id` is empty
- artifact count is `0`
- runner ends at `replicas=0`
- no runner pods remain

## Rollout

Keep this PR draft and stacked on #512. The script is manual and must not be wired into normal deployment. After user testing, a later slice can add a provider-backed or fake-provider completion canary.
