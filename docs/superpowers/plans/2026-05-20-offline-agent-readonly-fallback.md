# Offline Agent Read-Only Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep a user's Cloud agent reachable after the owner desktop app is closed by running a server-side read-only fallback runtime with the same agent/provider-auth model as local auth.

**Architecture:** Implement this in slices. First add server-side protocol detection and fallback trigger safety so the Cloud server can identify agent mentions without relying on an online desktop. Then add server-owned runtime capability/profile records, provider-auth snapshot sync using the local auth schema, and a gated fallback worker that can run only read-only/remote-safe tools. Desktop continues to own local-device execution when online.

**Tech Stack:** Rust cloud server (`bridges/cloud-server`), Postgres migrations, TypeScript desktop Cloud client/hooks, existing agent crates (`kordi-cli`, `kordi-provider`, `kordi-tools`) for provider/auth/runtime behavior, Node/Rust tests.

---

## File Structure

- `bridges/cloud-server/src/offline_agent.rs`: pure server-side Cloud agent protocol helpers: control-message parse, mention detection, request/response dedupe, local-tool pause copy.
- `bridges/cloud-server/src/lib.rs`: exports `offline_agent`.
- `bridges/cloud-server/src/auth/routes.rs`: calls fallback trigger after message persistence; later adds provider-auth snapshot endpoints.
- `bridges/cloud-server/migrations/0015_cloud_agent_runtime.sql`: stores owner runtime status, route metadata, and provider-auth snapshots.
- `app/desktop/src/features/cloud/authClient.ts`: adds runtime status/auth snapshot client methods.
- `app/desktop/src/features/cloud/useCloudBridgeState.ts`: publishes owner runtime status and provider-auth snapshot; suppresses duplicate desktop execution when server fallback has claimed a request.
- `agent/crates/cli/src/cloud_fallback_runtime.rs`: reusable read-only runtime wrapper around the same provider/auth path as local auth, with local tools disabled.
- Tests:
  - Rust unit tests in `offline_agent.rs`.
  - Cloud server e2e tests in `bridges/cloud-server/tests/cloud_auth_e2e.rs` for status/auth snapshot routes and fallback response insertion.
  - Desktop TS tests for client methods and duplicate suppression.

---

### Task 1: Server-side agent mention protocol helpers

**Files:**
- Create: `bridges/cloud-server/src/offline_agent.rs`
- Modify: `bridges/cloud-server/src/lib.rs`

- [ ] **Step 1: Write failing Rust unit tests**

Add tests covering:
- Direct message `@<owner name> Kordi` mention detection.
- First-person mentions like `@my kordi` must not target a remote owner's agent on the server.
- Existing `kordi-cloud-agent-response:` envelopes suppress duplicate fallback.
- Group control payloads are recognized as not direct fallback requests.

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
cargo test -p kordi-cloud-server offline_agent --lib
```

Expected: fail because `offline_agent` does not exist/export yet.

- [ ] **Step 3: Implement minimal helper module**

Create `offline_agent.rs` with pure functions:
- `normalized_agent_mention`
- `message_mentions_named_agent`
- `is_cloud_agent_response_body`
- `should_start_direct_fallback`
- `local_execution_paused_message`

Export it from `lib.rs`.

- [ ] **Step 4: Run tests to verify GREEN**

Run:

```bash
cargo test -p kordi-cloud-server offline_agent --lib
```

Expected: all `offline_agent` tests pass.

- [ ] **Step 5: Commit**

```bash
git add bridges/cloud-server/src/offline_agent.rs bridges/cloud-server/src/lib.rs
git commit -m "Add cloud offline agent protocol helpers"
```

---

### Task 2: Runtime presence and fallback capability records

**Files:**
- Create: `bridges/cloud-server/migrations/0015_cloud_agent_runtime.sql`
- Modify: `bridges/cloud-server/src/pg/pool.rs`
- Modify: `bridges/cloud-server/src/auth/routes.rs`
- Test: `bridges/cloud-server/tests/cloud_auth_e2e.rs`

- [ ] **Step 1: Write failing e2e tests**

Add tests for:
- Owner can mark runtime `online` with local execution available.
- Owner can mark runtime `offline` with read-only fallback enabled.
- Other users cannot update another owner's runtime state.

- [ ] **Step 2: Run RED**

```bash
cargo test -p kordi-cloud-server --test cloud_auth_e2e cloud_agent_runtime_status
```

Expected: route missing / DB table missing.

- [ ] **Step 3: Add migration and routes**

Add `cloud_agent_runtime_status` with account-scoped row:
- `account_id`
- `reachability_state`
- `local_execution_state`
- `readonly_fallback_enabled`
- `updated_at`

Add protected endpoint:
- `PUT /v1/cloud/agents/runtime-status`
- `GET /v1/cloud/agents/:account_id/runtime-status`

- [ ] **Step 4: Run GREEN**

Run the e2e test command again.

- [ ] **Step 5: Commit**

```bash
git add bridges/cloud-server/migrations/0015_cloud_agent_runtime.sql bridges/cloud-server/src/pg/pool.rs bridges/cloud-server/src/auth/routes.rs bridges/cloud-server/tests/cloud_auth_e2e.rs
git commit -m "Add cloud agent runtime status"
```

---

### Task 3: Same-auth provider snapshot sync foundation

**Files:**
- Modify: `bridges/cloud-server/migrations/0015_cloud_agent_runtime.sql`
- Modify: `bridges/cloud-server/src/auth/routes.rs`
- Modify: `app/desktop/src/features/cloud/authClient.ts`
- Test: `bridges/cloud-server/tests/cloud_auth_e2e.rs`
- Test: `app/desktop/tests/cloudAuthClient.test.tsx`

- [ ] **Step 1: Write failing tests**

Add tests proving:
- Owner can upload an agent auth snapshot in the same JSON shape used by local `auth.json`.
- Snapshot belongs only to the owner account.
- Snapshot is never returned to other accounts.
- Desktop client sends the snapshot through an authenticated Cloud request.

- [ ] **Step 2: Run RED**

```bash
cargo test -p kordi-cloud-server --test cloud_auth_e2e cloud_agent_auth_snapshot
pnpm --dir app/desktop exec tsx --test tests/cloudAuthClient.test.tsx
```

- [ ] **Step 3: Implement minimal sync route/client**

Add protected endpoint:
- `PUT /v1/cloud/agents/provider-auth-snapshot`

The request body stores:
- `formatVersion`
- `authJson`
- `activeProvider`
- `activeProfileId`
- `updatedAt`

The stored `authJson` remains account-scoped and is only loaded by server fallback runtime for that owner.

- [ ] **Step 4: Run GREEN**

Run both commands from Step 2.

- [ ] **Step 5: Commit**

```bash
git add bridges/cloud-server/src/auth/routes.rs bridges/cloud-server/tests/cloud_auth_e2e.rs app/desktop/src/features/cloud/authClient.ts app/desktop/tests/cloudAuthClient.test.tsx
git commit -m "Sync cloud agent provider auth snapshots"
```

---

### Task 4: Server fallback claim and local-tool pause response

**Files:**
- Modify: `bridges/cloud-server/src/auth/routes.rs`
- Test: `bridges/cloud-server/tests/cloud_auth_e2e.rs`

- [ ] **Step 1: Write failing e2e test**

When user A sends a message mentioning user B's agent and B runtime status is offline with fallback enabled, server inserts a response message from B to A using the cloud agent response envelope. If the request asks for local execution, the response says local execution is paused until B reconnects.

- [ ] **Step 2: Run RED**

```bash
cargo test -p kordi-cloud-server --test cloud_auth_e2e offline_agent_fallback
```

- [ ] **Step 3: Implement fallback claim scaffolding**

After `send_message` persists a message, call a background fallback trigger that:
- Checks recipient runtime status.
- Checks request mention target.
- Checks no response already exists.
- Inserts one response envelope if fallback should claim the request.

- [ ] **Step 4: Run GREEN**

Run the e2e test again.

- [ ] **Step 5: Commit**

```bash
git add bridges/cloud-server/src/auth/routes.rs bridges/cloud-server/tests/cloud_auth_e2e.rs
git commit -m "Claim offline cloud agent fallback requests"
```

---

### Task 5: Read-only fallback runtime using same agent core/auth path

**Files:**
- Create: `agent/crates/cli/src/cloud_fallback_runtime.rs`
- Modify: `agent/crates/cli/src/lib.rs` or module exports as needed
- Modify: `bridges/cloud-server/Cargo.toml`
- Modify: `bridges/cloud-server/src/auth/routes.rs`
- Test: Rust unit tests in the new runtime module and e2e fallback tests.

- [ ] **Step 1: Write failing tests**

Test that the fallback runtime:
- Loads the same provider/profile auth snapshot shape as local auth.
- Builds a provider request using the same provider/auth resolution path.
- Disables local filesystem, shell, sidecar, and local-browser tools.
- Allows remote-safe read-only tools only.

- [ ] **Step 2: Run RED**

```bash
cargo test -p kordi-cli cloud_fallback_runtime
cargo test -p kordi-cloud-server --test cloud_auth_e2e offline_agent_fallback
```

- [ ] **Step 3: Implement runtime wrapper**

Implement a read-only runtime that uses local agent/provider auth resolution but creates a tool context with local execution disabled.

- [ ] **Step 4: Run GREEN**

Run both commands from Step 2.

- [ ] **Step 5: Commit**

```bash
git add agent/crates/cli/src/cloud_fallback_runtime.rs agent/crates/cli/src/lib.rs bridges/cloud-server/Cargo.toml bridges/cloud-server/src/auth/routes.rs bridges/cloud-server/tests/cloud_auth_e2e.rs
git commit -m "Run read-only cloud fallback agent runtime"
```

---

### Task 6: Desktop runtime status and auth snapshot publishing

**Files:**
- Modify: `app/desktop/src/features/cloud/authClient.ts`
- Modify: `app/desktop/src/features/cloud/useCloudBridgeState.ts`
- Add or modify tests under `app/desktop/tests/`.

- [ ] **Step 1: Write failing TS tests**

Test that desktop:
- Publishes online/local-execution-available status while signed in.
- Publishes offline/read-only-fallback-enabled status before shutdown when possible.
- Uploads provider auth snapshot after provider auth changes.
- Suppresses duplicate local execution if a server fallback response already exists.

- [ ] **Step 2: Run RED**

```bash
pnpm --dir app/desktop exec tsx --test tests/cloudAuthClient.test.tsx tests/cloudBridgeState.test.tsx
```

- [ ] **Step 3: Implement desktop publishing**

Add client methods and hook calls. Keep local execution unchanged while desktop is online.

- [ ] **Step 4: Run GREEN**

Run the TS test command again.

- [ ] **Step 5: Commit**

```bash
git add app/desktop/src/features/cloud/authClient.ts app/desktop/src/features/cloud/useCloudBridgeState.ts app/desktop/tests/cloudAuthClient.test.tsx app/desktop/tests/cloudBridgeState.test.tsx
git commit -m "Publish cloud agent fallback readiness"
```

---

### Final Verification

Run:

```bash
cargo test -p kordi-cloud-server offline_agent --lib
cargo test -p kordi-cloud-server --test cloud_auth_e2e cloud_agent_runtime_status
cargo test -p kordi-cloud-server --test cloud_auth_e2e cloud_agent_auth_snapshot
cargo test -p kordi-cloud-server --test cloud_auth_e2e offline_agent_fallback
cargo test -p kordi-cli cloud_fallback_runtime
pnpm --dir app/desktop exec tsx --test tests/cloudAuthClient.test.tsx tests/cloudBridgeState.test.tsx
pnpm --dir app/desktop typecheck
```

Expected: all selected tests and typecheck pass.
