# Cloud agent sandbox fallback runtime design

## Parent issue

- Parent: #479 Keep agents reachable while owner device is offline
- Subissue: #494 Design Cloud sandbox fallback runtime for offline agents
- Subissue purpose: define the Cloud-hosted agent runtime architecture that keeps an owner's agent useful while the owner device is offline, without giving Cloud fallback access to the owner's local machine or other users' data.

## Goal

Build a K3s-hosted Cloud agent fallback runtime that mirrors the local agent experience while redirecting execution to isolated Cloud sandboxes when the owner device is offline.

The fallback should be:

- Load-balanced and efficient: use warm runner pools, not one instance per agent.
- Extensible: add capability-specific pools over time without changing chat semantics.
- Faithful to local behavior: same agent identity, skills, tool definitions, system prompt templates, provider/profile selection, and web-capable tool path.
- Safe by construction: owner-local/private actions are unavailable in Cloud fallback, and sandbox work cannot access other users' data.
- Useful offline: bash, file, code, and web work can proceed in a clean remote sandbox.

## Non-goals

- No owner laptop filesystem/shell access from Cloud fallback.
- No private local network, sidecar, localhost, or device-specific capability access while the owner device is offline.
- No access to other users' data or unsynced private resources.
- No one-pod-per-agent deployment model.
- No approval-prompt workflow for Cloud sandbox actions.
- No merging of the existing #490 draft/reference PR as-is; it remains a reference only and its read-only fallback direction is superseded by this design.

## Runtime model

When the owner device is online, the desktop remains the owner of local-device execution. Tool calls that need the owner's filesystem, shell, local services, or local provider state execute on the owner device according to existing local runtime rules.

When the owner device is offline, Cloud may claim eligible agent requests and run them through the Cloud fallback runtime. In this mode:

- The agent is the same logical agent/persona as local.
- The model loop runs in the trusted Cloud runner/control plane.
- Tool routing uses the same tool names and schemas as local where possible.
- Bash/files/code/browser-heavy work executes in a clean Cloud sandbox, not on the owner's machine.
- Web access follows the same web tool path available to local agents, hosted from the remote runner environment.
- Actions that require owner-local/private state are blocked or deferred immediately with an explanation grounded in the agent/runtime capability boundary.

Presence from #492 supplies the first routing signal: Cloud fallback is eligible only when the owner account/device is offline or unreachable according to server-side presence/runtime state.

## High-level architecture

### Trusted control plane

The trusted control plane runs in Cloud server / Cloud Agent Runner components and owns:

- Request detection, dedupe, cancellation, and fallback claiming.
- Session/contact/participant authorization.
- Provider-auth snapshot lookup and decryption.
- Model loop orchestration.
- Tool policy and routing.
- Billing, quotas, rate limits, audit logs, tracing, and recovery.
- Message, run, and artifact persistence.

The control plane does not expose arbitrary sandbox filesystem access to other users or sessions.

### Cloud Agent Runner pool

Use a K3s Deployment of warm `cloud-agent-runner` pods behind a service/queue. Runners are load-balanced workers, not agent-specific pods.

Initial slice:

- One general-purpose runner pool.
- One sandbox execution class capable of bash/files/code and web/browser tools.
- Queue/claim semantics to prevent duplicate Cloud and desktop responses.

Future slices can add capability-class pools, for example:

- Browser-heavy pool.
- Premium/high-memory code pool.
- Low-cost text-only orchestration pool.
- Restricted enterprise pool.

### Sandbox execution plane

The sandbox execution plane owns:

- A clean workspace filesystem.
- Shell/process execution.
- Package installs inside the sandbox boundary.
- Browser automation/runtime dependencies where enabled.
- Preview ports and generated files.
- Resource enforcement: CPU, memory, network policy, storage, process limits, and timeouts.

The sandbox does not own provider credentials, Cloud authorization, or chat persistence decisions. It receives scoped work from the trusted runner.

## Sandbox scope and persistence

Use persistent per chat/session sandboxes.

Scope rules:

- Group/project chat: shared session sandbox for work that belongs to that shared chat context.
- Direct/private chat: requester-isolated sandbox so one contact's private request does not share workspace state with another contact.
- Sensitive or permissioned requests can later force a fresh isolated sandbox without changing the general model.

Persistence rules:

- Keep sandbox workspace while the session exists and remains active.
- Clean up on session delete.
- Enforce inactivity TTLs and storage quotas.
- Preserve explicitly shared artifacts according to attachment/artifact retention, independent of sandbox cleanup.

Artifact visibility:

- Sandbox files are not automatically visible to all chat participants.
- The agent must explicitly share generated outputs as chat attachments or artifact links.
- Shared artifacts are persisted through the normal Cloud artifact/attachment path.

## Tool policy

Cloud fallback has no approval prompts. The policy gate decides automatically:

### Allowed automatically in Cloud sandbox

- `read`, `write`, `edit`, `find`, `grep`, `ls` scoped to the sandbox workspace.
- `bash` scoped to the sandbox execution environment.
- Code execution, package installation, and generated files within quota.
- `web_search`, `web_fetch`, and `browser_fetch` through the remote web-capable tool path.
- Artifact export when the agent explicitly shares a result.

### Blocked or deferred

- Owner laptop filesystem reads/writes.
- Owner laptop shell commands.
- Owner-local sidecars, localhost services, private networks, or GUI state.
- Secrets or provider state that were not explicitly snapshotted for Cloud use.
- Other users' data.
- Unsynced private resources.

Blocked actions should produce an immediate useful response that explains the capability boundary, for example by saying the agent is running from a Cloud sandbox while the owner's device is offline and cannot access owner-local resources. This should be a runtime/system-prompt principle, not scattered hard-coded one-off UI copy.

## Provider auth

Use an explicit Cloud provider-auth snapshot.

Rules:

- Owner opt-in is required before Cloud fallback can use provider credentials.
- Snapshot is account-scoped and tied to the Cloud account/device/session that published it.
- Snapshot is encrypted at rest with server-side key management.
- Snapshot stores only the active provider/profile material needed for Cloud execution.
- Snapshot can be revoked by the owner at any time.
- Snapshot use is audited per run.
- Cloud runner preserves local provider/auth-choice semantics: active provider, active auth profile, and provider-specific refresh behavior should match local behavior as closely as possible.

If no valid Cloud provider-auth snapshot exists, Cloud fallback should not attempt the model run. It should explain that the owner has not enabled Cloud execution credentials for offline fallback.

## Request routing and dedupe

Cloud fallback must not duplicate desktop execution.

Routing flow:

1. A message arrives that mentions or targets an agent.
2. Cloud server checks session authorization and whether the owner device/runtime is online.
3. If owner runtime is online, Cloud does not claim fallback execution.
4. If owner runtime is offline and fallback prerequisites are satisfied, Cloud creates/claims a fallback run with an idempotency key tied to the message/session/agent.
5. Runner processes the run and streams/persists assistant output through Cloud server.
6. If the owner device reconnects during a Cloud-claimed run, the desktop observes the claim/run state and does not start a duplicate response.
7. Cancellation markers/events stop the Cloud run and sandbox work best-effort.

Existing #490 protocol helpers for mention detection, dedupe, cancellation, and response prefixes can be reused where compatible, but the runtime target changes from read-only fallback to sandbox-capable fallback.

## Data isolation and authorization

Every fallback run is scoped by:

- requesting Cloud account,
- target owner/agent account,
- session ID,
- participant/contact authorization,
- sandbox ID,
- provider-auth snapshot ID,
- run ID.

Before running an agent turn, the control plane must verify:

- requester can see and write in the session,
- target agent belongs to an accepted contact/participant context where fallback is allowed,
- requested sandbox scope matches session privacy rules,
- provider-auth snapshot belongs to the owner account and is not revoked,
- no tool request crosses into another user's data or private owner-local resources.

## K3s deployment shape

Initial components:

- `kordi-cloud-server`: existing API, auth, presence, messages, event fanout, run claims.
- `cloud-agent-runner`: warm Deployment consuming fallback jobs and running model orchestration.
- `sandbox-executor`: isolated pod/job/execution unit for shell/files/browser-heavy work.
- Postgres: fallback run state, provider-auth snapshots, sandbox metadata, artifact metadata.
- Object storage: exported artifacts and attachments.
- Optional queue/Redis/NATS later: job leasing and backpressure if Postgres polling becomes insufficient.

The first implementation can keep job leasing in Postgres if that is simpler. The design should not couple chat semantics to that choice.

## UX principles

- Presence remains avatar-light-only from #492; do not add large status UI for this subissue.
- When fallback works, the user simply receives an agent answer while the owner is offline.
- When fallback cannot perform an owner-local/private action, the agent explains the boundary immediately and suggests what can be done from the Cloud sandbox or when the owner device returns.
- Avoid internal terms like Bridge in user-facing copy.

## Implementation slices

Suggested subissues after this design:

1. Runtime job model and fallback claim/dedupe.
2. Provider-auth snapshot opt-in, encryption, revocation, and audit.
3. Cloud Agent Runner service and model-loop bootstrap.
4. Sandbox workspace metadata, persistence, TTL, and quotas.
5. K3s runner/sandbox manifests and deployment scripts.
6. Tool backend remapping to sandbox execution.
7. Agent system-prompt/runtime policy for Cloud sandbox boundaries.
8. Artifact export/linking from sandbox to chat.
9. End-to-end tests using example-cloud-host/K3s and the three local preview users.

## Validation plan

Backend/unit validation:

- Fallback claim only when owner runtime is offline.
- Claim idempotency prevents duplicate Cloud responses.
- Desktop reconnect does not duplicate a Cloud-claimed run.
- Unauthorized session/requester cannot start a fallback run.
- Revoked/missing provider-auth snapshot blocks model execution.
- Sandbox tool policy allows sandbox-local tools and blocks owner-local tools.
- Artifact export creates scoped chat attachments/links only when explicitly shared.

K3s/e2e validation:

- Deploy Cloud server, runner, and sandbox executor to example-cloud-host K3s.
- Use the existing tunnel: local `127.0.0.1:17081` -> example-cloud-host `127.0.0.1:17082` -> k3s `svc/kordi-cloud-server:17081`.
- Use exactly three preview instances: `1482`, `1484`, `1486`.
- Sign in three users and establish contacts/group session.
- Enable provider-auth snapshot for one owner.
- Quit/hide the owner device and wait for offline presence.
- Mention the owner's agent from another accepted contact.
- Confirm Cloud fallback answers once, uses sandbox tools, and cannot read owner-local files.
- Reopen owner device and confirm future turns route to desktop/local execution without duplicating Cloud fallback.

## Open implementation notes

- Keep #490 draft/reference unmerged; mine reusable protocol pieces only after reconciling with this design.
- Presence is necessary but may not be sufficient; future runtime health should distinguish online UI presence from agent-runtime availability.
- The sandbox/control-plane boundary should remain explicit in code to avoid accidental credential or data leakage into sandbox containers.
