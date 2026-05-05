# Identity Collaboration Prompt Template Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close #101 and #106 by adding one reusable, versioned identity/collaboration prompt frame for local, project, Bridge, and delegated people/agent sessions.

**Architecture:** Add a canonical Rust identity-frame builder under `canonical_sessions`, then make existing local `@Kordi`, Bridge outreach, remote Bridge-agent, and `reach_out` prompt paths render through it instead of stitching display-name prose. Keep current simple single-user prompts concise; only attach the full frame when a session has non-local people/agents, explicit `@` participation, Bridge outreach, or project collaboration context.

**Tech Stack:** Rust/Tauri desktop backend, SQLite canonical sessions, Bridge payload JSON, existing TypeScript desktop view models and node:test coverage.

**Issues:** Refs #101, #106.

---

## Current root-cause findings

- `agent/crates/core/src/agent/helpers.rs` contains only a generic default prompt and local `@Kordi` guidance.
- `app/desktop/src-tauri/src/canonical_sessions/prompt_context.rs` has two ad hoc prompt builders:
  - `local_agent_session_prompt_context()` uses display-name-first participant lines.
  - `bridge_agent_parent_session_prompt()` says `You are {agent_name}` and loses requester/initiator/owner/target semantics.
- `app/desktop/src-tauri/src/bridge/events.rs::mailbox_payload_agent_prompt_text()` reads `sessionThread` but only forwards `parentSessionId`, `targetDisplayName`, request text, and context to the canonical prompt builder.
- `app/desktop/src-tauri/src/bridge/conversation_actions.rs` already forwards `sessionThread.participants` and `sessionThread.messages`, but not a dedicated initiator/self/target identity frame.
- `agent/crates/tools/src/reach_out.rs` and `app/desktop/src-tauri/src/bridge/outreach.rs` enforce explicit-target use, but the tool path does not enrich outbound outreach with canonical parent participants/messages.
- `context_snapshots.participant_hash` currently hashes only the target identity, not the full participant graph plus permission policy required by #106.
- OpenAI prompt-caching docs add provider-specific constraints this plan must preserve:
  - cache hits require exact prompt-prefix matches, so stable instructions/tool schemas must stay at the beginning and variable identity/session/message data must move later;
  - caching is automatic for prompts at or above 1024 tokens, while `usage.prompt_tokens_details.cached_tokens` / `usage.input_tokens_details.cached_tokens` reports actual cache hits;
  - `prompt_cache_key` should be stable for requests that share common prefixes, but must not include high-cardinality session or participant IDs that would fragment routing;
  - explicit extended `prompt_cache_retention` can persist key/value tensors for longer, so this issue must not enable extended retention by default without a separate user-facing privacy setting.

---

## Task 1: Add failing identity-frame renderer tests

**Files:**
- Modify: `app/desktop/src-tauri/src/canonical_sessions/tests.rs`
- Later create: `app/desktop/src-tauri/src/canonical_sessions/identity_context.rs`
- Later modify: `app/desktop/src-tauri/src/canonical_sessions.rs`

- [ ] **Step 1: Add tests for the reusable frame shape**

Add tests that import the future renderer from `canonical_sessions` and assert the rendered string contains these exact markers:

- `<multi_participant_identity_context version="v1">`
- `Current model/self:`
- `Requester / initiator:`
- `Current target:`
- `Session participants:`
- `Permissions:`
- `Rules:`
- `identityId: agent:alice-kordi`
- `owner: Alice (human:alice)`
- `replyAs: agent:alice-kordi only`
- `reachOut: allowed only for explicit non-local @Person/@Agent mentions in the current user message`

The test should construct a local Alice/Alice's Kordi + Bob/Bob's Kordi graph and verify deterministic participant ordering by canonical identity id.

- [ ] **Step 2: Add denial-policy test**

Add a second renderer test that sets `allowed_targets` to an empty list and asserts the output contains:

```text
reachOut: disabled; ask the local user when a non-local target is ambiguous or not permitted
allowedTargets: []
mayImpersonate: none
```

- [ ] **Step 3: Verify red**

Run:

```bash
cargo test -p kordi-desktop identity_context --lib
```

Expected: FAIL with an unresolved import for `identity_context` / `render_multi_participant_identity_context`.

---

## Task 2: Implement the versioned identity-frame builder

**Files:**
- Create: `app/desktop/src-tauri/src/canonical_sessions/identity_context.rs`
- Modify: `app/desktop/src-tauri/src/canonical_sessions.rs`

- [ ] **Step 1: Add the module and exports**

In `app/desktop/src-tauri/src/canonical_sessions.rs`, add:

```rust
mod identity_context;
pub(crate) use self::identity_context::{
    render_multi_participant_identity_context, IdentityContextParticipant,
    IdentityContextPermissions, IdentityContextRequest, IdentityContextRole,
};
```

- [ ] **Step 2: Implement focused data types**

In `identity_context.rs`, define these structs/enums:

```rust
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct IdentityContextParticipant {
    pub identity_id: String,
    pub display_name: String,
    pub kind: String,
    pub role: String,
    pub owner_identity_id: Option<String>,
    pub owner_display_name: Option<String>,
    pub bridge_node_id: Option<String>,
    pub human_id: Option<String>,
    pub agent_id: Option<String>,
    pub runtime: Option<String>,
    pub locality: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct IdentityContextRole {
    pub identity_id: String,
    pub display_name: String,
    pub kind: String,
    pub owner_identity_id: Option<String>,
    pub owner_display_name: Option<String>,
    pub locality: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct IdentityContextPermissions {
    pub reply_as_identity_id: String,
    pub allowed_targets: Vec<String>,
    pub reach_out_allowed: bool,
    pub context_policy: String,
    pub requires_approval: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct IdentityContextRequest {
    pub self_identity: IdentityContextRole,
    pub requester: Option<IdentityContextRole>,
    pub target: Option<IdentityContextRole>,
    pub participants: Vec<IdentityContextParticipant>,
    pub permissions: IdentityContextPermissions,
    pub session_id: Option<String>,
    pub session_kind: Option<String>,
    pub project_name: Option<String>,
}
```

- [ ] **Step 3: Implement deterministic rendering**

Implement `render_multi_participant_identity_context(input: &IdentityContextRequest) -> String` with these rules:

- Trim empty strings before rendering.
- Sort participants by `identity_id`, then `kind`, then `display_name`.
- Render canonical IDs before display names.
- Render owner relationship for agents when available.
- Render `bridgeNodeId`, `humanId`, `agentId`, and `runtime` only when present.
- Always render the permissions block.
- Always include rules that forbid impersonation and speaker-label prefixes.
- Render a stable template preamble and rules scaffold before variable identity values so OpenAI prompt caching can match the longest possible common prefix.
- Keep recent messages, request text, and user-specific context outside the stable preamble and after identity metadata.
- Do not add padding or synthetic text just to cross OpenAI's 1024-token prompt-caching threshold.

- [ ] **Step 4: Verify renderer tests pass**

Run:

```bash
cargo test -p kordi-desktop identity_context --lib
```

Expected: PASS.

---

## Task 3: Use the builder for local and remote prompt contexts

**Files:**
- Modify: `app/desktop/src-tauri/src/canonical_sessions/prompt_context.rs`
- Modify: `app/desktop/src-tauri/src/canonical_sessions/tests.rs`

- [ ] **Step 1: Add tests for local `@Kordi` prompt context**

Add a test that creates canonical identities for:

- `human:alice` / Alice
- `agent:alice-kordi` / Alice's Kordi, owned by Alice
- `human:bob` / Bob
- `agent:bob-kordi` / Bob's Kordi, owned by Bob

Create a session with all four participants and call `local_agent_session_prompt_context(Some(session_id))`.

Assert that the prompt contains:

```text
<multi_participant_identity_context version="v1">
Current model/self:
- identityId: agent:alice-kordi
- displayName: Alice's Kordi
Requester / initiator:
- identityId: human:alice
Session participants:
- agent:alice-kordi | Alice's Kordi | agent | owner: Alice (human:alice)
- agent:bob-kordi | Bob's Kordi | agent | owner: Bob (human:bob)
- human:alice | Alice | human
- human:bob | Bob | human
```

- [ ] **Step 2: Add tests for remote Bridge-agent prompt context**

Add a test for `bridge_agent_parent_session_prompt(...)` that passes a Bob's Kordi target and a session containing Alice, Alice's Kordi, Bob, and Bob's Kordi.

Assert that the prompt contains self, requester, target, owner relationship, participant graph, and request text. Assert it does not contain a bare `You are Kordi.`-only prompt as the only identity instruction.

- [ ] **Step 3: Query canonical IDs and owners in `prompt_context.rs`**

Replace the display-name-only participant queries with queries that select:

```sql
i.id, i.display_name, i.kind, sp.role, owner.id, owner.display_name,
i.bridge_node_id, i.human_id, i.agent_id, i.source, i.metadata
```

Use these rows to build `IdentityContextParticipant` values.

- [ ] **Step 4: Preserve concise simple-session behavior**

Keep returning the current concise local context when the session has only the local human/local agent and no Bridge/project/non-local participants. Render the full frame when participant count is greater than two, any participant source is Bridge, session kind is `group` or `project`, or a target/requester is passed.

- [ ] **Step 5: Verify prompt-context tests**

Run:

```bash
cargo test -p kordi-desktop prompt_context --lib
```

Expected: PASS.

---

## Task 4: Preserve identity-frame metadata through Bridge `sessionThread`

**Files:**
- Modify: `app/desktop/src-tauri/src/bridge/mod.rs`
- Modify: `app/desktop/src-tauri/src/bridge/conversation_actions.rs`
- Modify: `app/desktop/src-tauri/src/bridge/events.rs`
- Modify: `app/desktop/src-tauri/src/bridge/mailbox.rs`
- Modify: `app/desktop/src-tauri/src/bridge/realtime/local_agent.rs`
- Modify: `app/desktop/src/kordi-app/types.ts`

- [ ] **Step 1: Add typed identity snapshots to Bridge structs**

Add a serializable Rust struct near `DesktopBridgeSessionParticipant`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopBridgePromptIdentity {
    pub identity_id: Option<String>,
    pub display_name: String,
    pub kind: String,
    pub owner_identity_id: Option<String>,
    pub owner_display_name: Option<String>,
    pub bridge_node_id: Option<String>,
    pub human_id: Option<String>,
    pub agent_id: Option<String>,
    pub runtime: Option<String>,
}
```

Extend `DesktopBridgeSessionParticipant` with optional `kind`, `owner_identity_id`, `owner_display_name`, and `runtime` fields. Keep serde defaults so old payloads still decode.

- [ ] **Step 2: Extend outreach metadata and create request**

Add optional fields to `DesktopBridgeOutreachMetadata` and `DesktopBridgeCreateOutreachRequest`:

```rust
pub initiator_identity: Option<DesktopBridgePromptIdentity>,
pub self_target_identity: Option<DesktopBridgePromptIdentity>,
pub permission_policy_hash: Option<String>,
pub participant_graph_hash: Option<String>,
```

- [ ] **Step 3: Include metadata in outbound `sessionThread`**

In `conversation_actions.rs`, when building `session_thread`, include:

```rust
"initiator": &outreach.initiator_identity,
"selfTarget": &outreach.self_target_identity,
"participantGraphHash": outreach.participant_graph_hash.as_deref(),
"permissionPolicyHash": outreach.permission_policy_hash.as_deref(),
```

- [ ] **Step 4: Consume metadata for remote prompts**

In `events.rs::mailbox_payload_agent_prompt_text()`, parse `sessionThread.initiator`, `sessionThread.selfTarget`, and `sessionThread.participants` into an `IdentityContextRequest`. Use this payload-derived request when the receiver has not yet reconstructed the canonical parent session locally.

- [ ] **Step 5: Add Bridge payload tests**

Add tests asserting that outbound ask payloads include `sessionThread.initiator`, `sessionThread.selfTarget`, participant owner fields, and graph/policy hashes. Add a mailbox prompt test asserting a receiver can render the full identity frame using only payload data.

- [ ] **Step 6: Update TypeScript types**

In `app/desktop/src/kordi-app/types.ts`, add matching optional camelCase fields to `DesktopBridgeSessionParticipant`, `DesktopBridgeOutreachMetadata`, and `DesktopBridgeCreateOutreachRequest`.

---

## Task 5: Enrich `reach_out` tool-created outreach with canonical parent context

**Files:**
- Modify: `agent/crates/tools/src/types.rs`
- Modify: `agent/crates/tools/src/reach_out.rs`
- Modify: `app/desktop/src-tauri/src/chat.rs`
- Modify: `app/desktop/src-tauri/src/bridge/outreach.rs`
- Modify: `app/desktop/src-tauri/src/bridge/conversation_commands.rs`

- [ ] **Step 1: Keep tool schema minimal**

Do not expose identity graph fields to the model-facing `reach_out` schema. Keep the model input as target/message/context/policy only.

- [ ] **Step 2: Add runtime-only parent context fields**

Extend `ReachOutRequest` in `agent/crates/tools/src/types.rs` with runtime-filled fields:

```rust
pub parent_session_participants_json: Option<serde_json::Value>,
pub parent_session_messages_json: Option<serde_json::Value>,
```

Initialize both to `None` in `agent/crates/tools/src/reach_out.rs`.

- [ ] **Step 3: Populate parent context in desktop runtime**

In `chat.rs::install_reach_out_runtime()`, after setting `parent_session_id`, query canonical session participants/messages for that session and set the new runtime fields. Use the same participant/message limits as existing UI outreach: participants capped at 50, messages capped at 16.

- [ ] **Step 4: Pass context into Bridge create outreach**

In `bridge/outreach.rs`, deserialize the runtime-only JSON fields into `Vec<DesktopBridgeSessionParticipant>` and `Vec<DesktopBridgeSessionThreadMessage>` and pass them into `DesktopBridgeCreateOutreachRequest` instead of empty vectors.

- [ ] **Step 5: Add permission enforcement assertions**

Keep the existing `reach_out_target_allowed_by_user_text()` check in `chat.rs` as the backend permission boundary. Add tests that prove:

- generic `@Kordi` cannot target a remote agent
- hidden/unmentioned targets are denied
- explicit `@Bob's Kordi` allows only Bob's Kordi
- payload metadata records `reachOut` as allowed for the explicit target only

---

## Task 6: Make context/cache hashes identity- and permission-aware

**Files:**
- Modify: `app/desktop/src-tauri/src/canonical_sessions/parent_sessions/outreach.rs`
- Modify: `app/desktop/src-tauri/src/canonical_sessions/tests.rs`

- [ ] **Step 1: Add deterministic graph/policy hash helpers**

Add helpers that produce:

- `participant_graph_hash`: hash of sorted participant identity IDs, kinds, roles, owner IDs, target ID, and initiator ID.
- `permission_policy_hash`: hash of reply-as identity, allowed target IDs, reach-out enabled/disabled, context policy, and approval requirement.

- [ ] **Step 2: Store graph-aware participant hash**

Change `store_outreach_context_snapshot()` so `participant_hash` is the participant graph hash when available, falling back to the current target-identity hash for legacy outreach metadata.

- [ ] **Step 3: Include permission hash in prompt/message hash inputs**

Include `permission_policy_hash` in the `prompt_hash` or `message_range_hash` seed so a context snapshot generated under permissive rules cannot be reused after permissions become stricter.

- [ ] **Step 4: Add cache invalidation tests**

Add tests showing different hashes when participants, owners, target, provider/model, context policy, or permission policy changes.

---

## Task 7: Frontend identity data plumbing for direct UI outreach

**Files:**
- Modify: `app/desktop/src/features/chat/messageActions/context.ts`
- Modify: `app/desktop/src/features/chat/messageActions/chatMessages.ts`
- Modify: `app/desktop/src/features/chat/messageActions/projectMessages.ts`
- Modify: `app/desktop/src/features/chat/messageActions/relay.ts`
- Modify: `app/desktop/tests/chatRouting.test.tsx`
- Modify: `app/desktop/tests/mentions.test.tsx`

- [ ] **Step 1: Build richer participant snapshots**

Update existing `parentSessionParticipants` builders to include kind, owner identity/display name, runtime, and canonical IDs when present. Preserve existing fields so old backend expectations still pass.

- [ ] **Step 2: Add initiator and self-target metadata**

When UI code calls `createDesktopBridgeOutreach()`, include initiator identity and target identity snapshots from the active canonical session/mention target.

- [ ] **Step 3: Verify group/direct/project mention flows**

Add/update tests covering:

- user-authored `@Person`
- user-authored `@Agent`
- agent-authored `@Person`
- agent-authored `@Agent`
- group session participant snapshots
- project session outreach snapshots

---

## Task 8: Align OpenAI prompt-cache routing with the identity template

**Files:**
- Modify: `agent/crates/provider/src/openai.rs`
- Modify: `agent/crates/provider/src/openai/responses.rs`
- Modify: `agent/crates/provider/src/openai/codex.rs`
- Modify: `app/desktop/src-tauri/src/canonical_sessions/identity_context.rs`

- [ ] **Step 1: Add provider cache-key tests**

Add tests proving:

- ordinary prompts keep the existing key: `kordi:<model>`
- prompts containing `<multi_participant_identity_context version="v1">` use a stable low-cardinality key: `kordi:<model>:identity-v1`
- the key does not include `session_id`, `participant_graph_hash`, `permission_policy_hash`, human IDs, agent IDs, or Bridge node IDs
- Responses API and Codex OAuth request bodies both use the same helper

- [ ] **Step 2: Implement a prompt-cache key helper**

Replace direct calls to `default_prompt_cache_key(&request.model)` with a helper shaped like:

```rust
pub(super) fn prompt_cache_key_for_request(model: &str, system_prompt: &str) -> String {
    if system_prompt.contains("<multi_participant_identity_context version=\"v1\">") {
        format!("kordi:{model}:identity-v1")
    } else {
        default_prompt_cache_key(model)
    }
}
```

Use this helper in:

- `agent/crates/provider/src/openai.rs` Chat Completions body
- `agent/crates/provider/src/openai/responses.rs` Responses body
- `agent/crates/provider/src/openai/codex.rs` Codex OAuth Responses body

- [ ] **Step 3: Keep extended retention opt-in only**

Add provider tests asserting the OpenAI request bodies do not include `prompt_cache_retention` by default. Do not set `prompt_cache_retention: "24h"` in this issue; extended retention has separate privacy/data-residency implications and needs an explicit product setting before enabling.

- [ ] **Step 4: Preserve cached-token telemetry**

Add or update tests proving OpenAI usage parsing still captures cached tokens from both shapes:

```json
{ "prompt_tokens_details": { "cached_tokens": 1920 } }
{ "input_tokens_details": { "cached_tokens": 1920 } }
```

The existing `UsageInfo.cache_read_tokens` should continue to receive the cached-token count so cache-hit rate can be monitored without adding new UI in this issue.

- [ ] **Step 5: Verify provider cache tests**

Run:

```bash
cargo test -p kordi-provider prompt_cache --lib
cargo test -p kordi-provider cached_tokens --lib
```

Expected: PASS.

---

## Task 9: Full verification and issue handoff

**Files:**
- No production edits in this task.

- [ ] **Step 1: Rust focused tests**

Run:

```bash
cargo test -p kordi-desktop identity_context --lib
cargo test -p kordi-desktop prompt_context --lib
cargo test -p kordi-desktop bridge --lib
cargo test -p kordi-provider prompt_cache --lib
cargo test -p kordi-provider cached_tokens --lib
```

Expected: PASS.

- [ ] **Step 2: Rust backend/provider suites**

Run:

```bash
cargo test -p kordi-desktop --lib
cargo test -p kordi-provider --lib
```

Expected: PASS.

- [ ] **Step 3: Desktop frontend checks**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/chatRouting.test.tsx tests/mentions.test.tsx
pnpm --dir app/desktop typecheck
pnpm --dir app/desktop test:unit
```

Expected: PASS.

- [ ] **Step 4: Workspace hygiene**

Run:

```bash
git diff --check
git status --short
```

Expected: no whitespace errors; only intentional files changed.

- [ ] **Step 5: GitHub issue update**

Comment on #101 and #106 with:

- summary of the identity-frame builder
- Bridge/sessionThread metadata changes
- permission/cache hash coverage
- verification commands and results

Close #101 when reusable template support lands. Close #106 when Bridge/local/remote multi-participant prompts and tests land.

---

## Recommended implementation order

1. Tasks 1-2: pure renderer and tests.
2. Task 3: local/remote prompt use.
3. Tasks 4-5: Bridge payload and `reach_out` enrichment.
4. Task 6: Kordi context/cache hashing.
5. Task 7: frontend plumbing.
6. Task 8: OpenAI prompt-cache routing alignment.
7. Task 9: verification and issue handoff.

This order keeps the core prompt contract testable before Bridge/frontend plumbing depends on it, then aligns provider cache routing once the identity template marker is stable.
