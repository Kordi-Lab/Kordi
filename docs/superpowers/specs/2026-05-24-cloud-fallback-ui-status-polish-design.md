# Cloud Fallback UI/Status Polish Design

## Goal

Make Cloud fallback feel like the normal online agent experience from the user's side, with minimal visible change. The user should see an agent turn in the same transcript slot and only see Cloud-specific language when there is a failure that needs explanation.

## Scope

This slice is intentionally narrow:

- no always-on runner changes
- no new polling loop
- no large transcript redesign
- no new visible Cloud badge for successful turns

## Design

### User experience

Successful Cloud fallback should look like a regular agent reply. Intermediate waiting copy should stay close to existing online copy such as "Requesting…", "Processing…", or "Replying…". Do not add loud labels like "Cloud sandbox" to normal success paths.

Failures should be clearer than raw backend/runtime strings:

- missing provider auth: "Provider auth is not synced for Cloud fallback yet. Open this device once to sync provider access."
- owner online: "The owner device is online, so Kordi will answer from the device."
- owner-local/private resource blocked: "Kordi Cloud can't access that local/private resource while the device is offline."
- model provider error: "The provider failed while Kordi Cloud was replying. Try again in a moment."
- sandbox/backend error: "Kordi Cloud couldn't finish this reply in the sandbox. Try again."

### Implementation shape

Add a small pure TypeScript mapping helper in `cloudAgentMessages.ts`:

- `cloudAgentFallbackStatusLabel(status)` for quiet labels when needed
- `cloudAgentFallbackErrorNotice(input)` for user-facing failure copy
- `isCloudAgentFallbackNoProviderError(value)` extends current no-provider detection to include Cloud runner/server `missing_provider_auth` wording

Use these helpers from existing transcript/read-model surfaces instead of raw error text where possible. Keep the same message shape (`agent-turn`, `deliveryState`, `status`) so rendering remains identical to online turns.

Add typed claim request/response methods to `authClient.ts` so later UI code has a safe API boundary for `/v1/cloud/agent-runs/claim`, but this slice does not wire a new polling/status view.

## Tests

- `cloudAgentMessages.test.tsx`: mapping tests for Cloud fallback status/error copy and no-provider detection.
- `cloudAuthClient.test.tsx`: claim endpoint request/response shape.
- Existing transcript/read-model tests should continue passing.

## Safety

No Cloud runner deployment behavior changes. UI changes only. The runner remains off/manual by default.
