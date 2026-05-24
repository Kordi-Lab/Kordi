# Cloud Runner Real-Provider Canary Design

## Parent

- Parent issue: #479 offline Cloud agent fallback
- Runtime umbrella: #494 Cloud sandbox fallback runtime
- Prior slice: #513/#514 fail-closed live runner canary
- This slice: #515 real-provider live runner canary

## Goal

Run a manual Cloud runner canary using the operator's existing local provider auth, publish that auth into Cloud provider-auth snapshots for a controlled canary owner, and verify one scoped Cloud runner run completes through the real model loop.

## Current local auth finding

The operator's local auth store at `~/.kordi/auth.json` has active OpenAI OAuth auth. Local API key env vars are not set. Therefore this canary must support publishing OpenAI OAuth access material, not only API-key material.

## Design

### Local auth extraction helper

Add a local-only helper binary under `kordi-cloud-agent-runner`:

- `cloud-provider-auth-snapshot-payload`

It uses the existing `kordi_cli::login` resolver so refreshable local OAuth credentials are resolved the same way the desktop/runtime resolves them. It outputs a JSON provider-auth snapshot body suitable for `POST /v1/cloud/agent-provider-auth/snapshots`:

```json
{
  "provider": "openai-codex",
  "authChoice": "local-active-oauth",
  "payload": {
    "apiMode": "openai-codex-oauth",
    "accessToken": "...",
    "accountId": "...",
    "model": "gpt-5"
  }
}
```

The helper must not log the credential to stderr. The shell script pipes stdout directly to the remote canary process.

### Runner OpenAI OAuth provider support

Extend the cloud runner model provider path to recognize provider-auth payloads with:

- `apiMode: "openai-codex-oauth"`
- `accessToken`
- optional `accountId`
- optional `baseUrl`
- optional `model`

For that payload shape, the runner calls the same public ChatGPT/Codex backend family as local OpenAI OAuth support, parses the SSE response, and returns final text. This is scoped to the canary/MVP path and does not enable owner-local provider endpoints.

### Local operator canary script

Add `bridges/cloud-agent-runner/scripts/k8s-runner-real-provider-canary.sh` and run it locally.

It:

1. Requires `CONFIRM_KORDI_RUNNER_REAL_PROVIDER_CANARY=1`.
2. Resolves local auth with the helper.
3. Sends the snapshot JSON over SSH stdin to a remote Python/Bash canary runner on takotako.
4. The remote runner:
   - port-forwards Cloud server locally on takotako
   - signs up controlled owner/requester accounts
   - publishes the provider-auth snapshot using the owner token
   - directly seeds one canary sandbox/run in Postgres
   - patches runner env to `KORDI_CLOUD_RUNNER_CANARY_IDLE=0` and `KORDI_CLOUD_RUNNER_CANARY_RUN_ID=<run>`
   - scales runner to 1
   - waits for `completed`
   - verifies `response_message_id` is non-empty and `error_code` is empty
   - restores idle mode, removes canary run id, scales to 0, and waits for no runner pods

### Safety controls

- No fake provider is used.
- No local/localhost provider endpoint is used by Cloud.
- Snapshot publishing goes through the normal Cloud server endpoint so encryption/audit behavior is production-like.
- Runner lease is scoped by `canaryRunId` from #513.
- Cleanup restores runner idle/zero state even on failure.
- The script does not print provider credentials.

## Verification

Local:

- helper tests for auth payload shaping without secrets in logs
- provider parser tests for OpenAI OAuth SSE final text and error events
- canary script static tests
- runner/server regressions

Remote:

- run script against K3s
- observe provider snapshot created for controlled owner
- observe canary run completed
- observe response message id exists
- observe runner restored to replicas 0 with no runner pods

## Rollout

Keep PR draft/stacked. Do not merge before user testing. This is still a manual canary, not a rollout of always-on Cloud fallback.
