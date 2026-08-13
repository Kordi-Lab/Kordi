# Cloud Runner Model Loop MVP Design

## Parent issue

- Parent: #479 Keep agents reachable while owner device is offline
- Runtime umbrella: #494 Cloud sandbox fallback runtime
- Prior slices: #495 runtime claims, #497 provider-auth snapshots, #499 runner skeleton, #501 sandbox metadata, #503 tool policy, #504 explicit artifact export
- Slice purpose: replace the placeholder Cloud Agent Runner completion with a real OpenAI-compatible model loop that can produce useful answers while preserving Cloud sandbox boundaries.

## Goal

When a fallback run is leased and the owner has an enabled provider-auth snapshot, the Cloud Agent Runner should execute a real model turn. The runner should call an OpenAI-compatible chat-completions endpoint, route requested tools through the Cloud sandbox policy/backend, optionally export artifacts through the explicit #504 path, and complete or fail the run with a truthful result.

## Non-goals

- No K3s sandbox executor pods yet; use the existing local sandbox backend abstraction for this slice.
- No runner deployment as a live queue consumer yet.
- No owner-local filesystem/shell/private network access.
- No approval prompts in Cloud fallback.
- No streaming UI or token-by-token events.
- No broad multi-provider matrix. This slice supports OpenAI-compatible snapshots first.
- No direct object-store access from runner; artifact export remains through #504 Cloud server endpoint.

## Architecture

### Server-side provider auth material endpoint

Add a runner-auth endpoint:

`POST /v1/cloud/agent-runs/:run_id/provider-auth`

Request:

```json
{ "runnerId": "runner-a" }
```

Response:

```json
{
  "providerAuth": {
    "snapshotId": "snap_...",
    "provider": "openai",
    "authChoice": "default",
    "payload": {
      "apiKey": "sk-...",
      "baseUrl": "https://api.openai.com/v1",
      "model": "gpt-4.1-mini"
    }
  }
}
```

Rules:

- Requires `KORDI_CLOUD_RUNNER_TOKEN`.
- Requires the run to exist, be claimed by the supplied `runnerId`, and be `leased` or `running`.
- Uses the run owner account to find the latest unrevoked snapshot.
- Decrypts payload in Cloud server using existing `EnvProviderAuthCipher`.
- Records provider-auth audit action `used` for the run.
- Returns `404 agent_run_not_found` for wrong runner/run/status.
- Returns `404 provider_auth_not_found` if no active snapshot exists.
- Never exposes provider auth through user-auth endpoints.

### Runner model loop

Add a `model_loop` module in `bridges/cloud-agent-runner` with small interfaces:

- `CloudModelProvider`: async trait for model calls.
- `OpenAiCompatibleProvider`: production implementation using `/chat/completions`.
- `ModelTurnRequest`: prompt, provider auth, run metadata, tool catalog.
- `ModelTurnOutcome`: final text or provider failure.

The default runner flow becomes:

1. Lease run.
2. Skip cancelled runs.
3. Fail closed if lease says provider auth unavailable.
4. Mark run running.
5. Fetch decrypted provider auth for this run from Cloud server.
6. Build Cloud fallback system prompt.
7. Call OpenAI-compatible model provider.
8. If model returns plain assistant text, complete run with that text.
9. If model returns tool calls, execute allowed sandbox tools and call the model again with tool results.
10. If model requests artifact export, call #504 helper and include export summary in the final response.
11. If provider/tool loop fails, fail the run with an explicit error code.

Limit this MVP to a small bounded loop: at most 3 model calls and at most 5 tool calls per run. Exceeding limits fails closed with `model_loop_limit_exceeded`.

### Prompt boundary

The runner system prompt must state:

- You are running in Kordi Cloud fallback because the owner device is offline.
- You may work only inside the Cloud sandbox workspace.
- You cannot read owner laptop files, owner-local services, localhost/private networks, other users' data, or unsynced private resources.
- Do not ask for approval prompts; unavailable actions should be explained as runtime boundaries.
- Export artifacts only when explicitly useful to share; unexported sandbox files remain private.

### Tool handling

Use the existing #503 `CloudToolExecutor` and policy gate. The model loop should translate model tool calls into `RunnerToolRequest` values and execute through `CloudToolExecutor` only.

Supported tool names for MVP:

- `read`
- `write`
- `edit`
- `ls`
- `find`
- `grep`
- `bash`
- `export_artifact`

`export_artifact` is runner-local orchestration: it reads a sandbox file and calls #504. It is not a general filesystem escape.

Unsupported or blocked tools are returned to the model as tool errors with runtime-boundary explanations. They must not trigger approval prompts.

### Provider payload shape

For OpenAI-compatible MVP, accept payload fields:

- `apiKey` or `accessToken`: bearer token. Empty token is allowed only for explicitly local-compatible endpoints in tests/dev, not production Cloud.
- `baseUrl`: defaults to `https://api.openai.com/v1` for provider `openai`.
- `model`: defaults to `gpt-4.1-mini` unless the snapshot includes a model.

Reject owner-local base URLs (`localhost`, `127.0.0.1`, `::1`, RFC1918/private/link-local ranges) in production runner provider config. Cloud fallback must not use owner-local provider endpoints.

## Testing

### Server e2e

- Runner provider-auth endpoint rejects user tokens and bad runner tokens.
- Wrong runner cannot fetch provider auth for another runner's lease.
- Missing/revoked provider auth returns `404 provider_auth_not_found`.
- Valid runner gets decrypted provider auth for the run owner only.
- Fetching provider auth records a `used` audit row for that run.

### Runner unit/integration tests

- Missing provider auth still fails closed.
- Fake model text response completes run with model text, not placeholder text.
- Provider-auth fetch failure marks run failed.
- Fake model tool call to sandbox `write` then `read` succeeds and produces final text.
- Fake model owner-local `read` call is blocked and the final answer contains the boundary explanation.
- Fake model export request calls #504 export helper and includes attachment/export summary.
- Provider errors mark run failed with `model_provider_error`.
- Loop limits are enforced.

### Remote verification

- `cargo test -p kordi-cloud-agent-runner`
- `cargo test -p kordi-cloud-server cloud_agent_runtime`
- Full example-cloud-host `cloud_agent_runtime_e2e` through VM-local Postgres port-forward.
- In-cluster `/health` smoke.

## Rollout

Keep this as a draft stacked PR on #504. Do not deploy runner pods as live consumers yet. The code should be production-shaped, but actual runner deployment should wait until the K3s sandbox executor slice or a controlled manual runner smoke.

## Self-review

- Placeholder scan: no TBD/TODO placeholders.
- Scope check: focused on model loop MVP and provider-auth retrieval; K3s executor and live deployment remain later slices.
- Consistency check: provider secrets are exposed only to runner-auth endpoints; user endpoints never return decrypted payloads.
- Boundary check: owner-local provider endpoints and owner-local tools remain blocked.
