# Unified OMP runtime

Kordi can run desktop and cloud turns through the same pinned OMP worker. The worker owns the model/tool loop, retries, and compaction. Kordi continues to own admission, account selection, conversation history, permissions, tool execution, and delivery.

## Execution boundary

```text
iOS or macOS request
  -> Kordi admission and durable request queue
  -> online owner Mac (including requests sent from iOS)
     -> desktop adapter -> Rust supervisor -> OMP worker
     -> Kordi local tools, plugins, and permitted native computer/browser use
  -> eligible cloud fallback when the owner Mac is unavailable
     -> cloud adapter -> same supervisor and worker
     -> existing cloud sandbox and scoped tools
```

A busy Mac retains its queue. Changing the model engine does not change the existing presence, lease, or fallback policy. Each admitted request has one execution owner, and cloud completion remains fenced by its active lease.

## Packages and transport

- `shared/omp-runtime` pins `@oh-my-pi/pi-coding-agent` and the matching catalog/native dependency family to `18.2.11`. It has a separate Bun 1.4.2 lockfile.
- `shared/rust/omp-runtime` supervises one JSONL worker per turn. Credentials travel through stdin, never process arguments or logs. Ambient provider credentials are not inherited.
- The desktop adapter lives in `agent/crates/cli/src/desktop_runtime/omp_turn.rs`; the cloud adapter lives in `bridges/cloud-agent-runner/src/model_loop/omp.rs`.
- A request freezes provider, model, account material, history, tools, and capability scope. Model fallback is disabled. Plugins cannot redirect the selected model.
- Frames carry run and attempt IDs plus monotonic output sequence numbers. Output size, execution time, model steps, and tool calls are bounded. Cancellation or supervisor shutdown terminates the worker process group, including its Eval subprocess.
- The cloud runner hands the worker only accounts on a provider's built-in endpoint. The worker opens its own provider connections, so it cannot check each DNS answer or redirect against the runner's address policy. An account with its own `baseUrl` runs on the Rust model loop, whose provider client checks both. Serving such accounts through OMP requires an address-checking egress proxy in the runner and an egress network policy for the runner pod first.

Kordi host tools override identically named OMP tools such as `read`, `edit`, and `bash`. The adapter uses OMP's `CustomTool` calling convention, including its fifth-position abort signal. This boundary is covered by actual worker tests.

## History and completion

The desktop persists the user request once before execution. Returned messages, raw replay sidecars, and compaction boundaries commit together in one SQLite transaction. Raw sidecars retain provider reasoning signatures and opaque fields while visible history keeps its existing format. A completed UI event follows successful persistence.

Cloud migration `0106_omp_runtime_state.sql` adds private runtime replay state. It is separate from synchronized chat content and scoped to owner, requester, session, execution agent, exact route, auth snapshot, and a canonical response anchor in the current thread. Completion stores replay state under the same lease fence as the final response. Expired leases cannot complete or fetch context. Hidden/deleted history and edits invalidate stale replay rather than resurfacing removed content. Queued requests retain a version fence, and attachment references are resolved again at execution time. Turns that retrieve private conversations, calendar data, or child-task context fall back to authorized canonical history on the next request until source-provenance revalidation is available; their private tool payloads are not replayed across turns.

Cloud processing continues to use the durable run lifecycle; subsession tools retain their existing activity updates. Cloud final text is delivered atomically. This migration does not add token-by-token cloud text streaming.

## Plugins and permissions

Kordi supplies explicit tools and hooks; the worker does not discover ambient plugins, MCP servers, skills, rules, or project instructions. Existing plugin tools retain their call IDs, working directory, output callbacks, cancellation, mutation scheduling, and Kordi permission checks. The host bridge also preserves context and provider-request hooks on each model step.

The OMP `before_provider_request` hook receives the provider's wire payload. Plugins that previously assumed Kordi's normalized `CompletionRequest` shape must adapt to the selected provider's payload. Context hooks continue to use Kordi's structured message representation. Opaque replay fields survive unchanged context.

Native computer/browser Eval is admitted only for an owner-local macOS turn with Kordi's existing YOLO execution policy. Shared/restricted and cloud turns do not receive Eval or these native capabilities. Native computer execution uses a private per-device advisory lock. macOS still controls Accessibility, input, and screen-capture permission. Packaging tests exercise Eval, the native computer worker capability query, and browser worker startup. They do not click or capture the user’s desktop.

## Development rollout

1. Install the pinned worker dependencies with `cd shared/omp-runtime && bun install --frozen-lockfile`.
2. Run worker tests and type checks: `bun test` and `bun run typecheck`.
3. Run the desktop runtime integration tests against synthetic loopback provider responses. They cover host tool execution, continuation, durable history, cancellation, and lifecycle events without using account credentials.
4. Use the supported isolated desktop launcher with `KORDI_DESKTOP_TURN_ENGINE=omp`. The current selector is debug-only; release desktop builds retain the Rust engine during staged rollout. The packaged `kordi-omp` sibling is preferred; source debug runs can use Bun.
5. Apply backend migration tests only to a task-owned database, then validate the cloud adapter and lease-fenced replay tests. Configure an isolated runner with `KORDI_CLOUD_AGENT_ENGINE=omp` and an absolute `KORDI_OMP_WORKER_ENTRY` pointing to the packaged executable.
6. Enable cloud OMP only after Mac parity is accepted. The development container includes the worker but defaults to the Rust engine unless explicitly selected.

The legacy loops remain available for rollback during this staged migration. Selecting `rust` affects new turns; it must not move an active turn between engines. Deployment, release-default changes, and removal of the legacy loops are separate rollout steps after acceptance.

Before changing defaults, verify the signed-in Mac preview with a configured account: send two requests while the first is active, observe processing and queue states, cancel a tool, and confirm one synchronized response per request. Repeat from iOS while the Mac is online and confirm a local tool runs on the Mac. Then take the Mac offline in an isolated environment and verify cloud fallback, lease expiry, and reconnect without duplicate completion. Synthetic worker tests cover the adapter boundary but do not replace these signed-in device checks. Browser extension attachment and macOS permission prompts also require interactive validation; the automated native checks use a capability query and an isolated blank browser only.

Desktop packaging builds the executable and matching native addon on the target platform and writes a target-specific Tauri overlay. Do not reuse a native addon from another architecture. Use the normal desktop preparation/build scripts so the sidecar and native dependency stay together.

Follow the repository's development-environment rules before starting previews or services. Never apply test fixtures or migrations to a shared backend.
