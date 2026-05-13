# Private Self-Agent Chat Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist, sync, and restore a private Cloud chat with the signed-in user's own Kordi agent.

**Architecture:** Allow Cloud self-messages server-side, then make the desktop Cloud bridge layer bootstrap and synthesize a self-agent conversation from those self-scoped rows. Keep `cloud-agent:*` runtime sessions filtered from canonical desktop sync.

**Tech Stack:** Rust/Axum/SQLx Cloud server, React/TypeScript Cloud bridge read model, Node `tsx --test`, Cargo e2e tests.

---

### Task 1: Allow self-scoped Cloud messages

**Files:**
- Modify: `bridges/cloud-server/src/auth/routes.rs`
- Modify: `bridges/cloud-server/tests/cloud_auth_e2e.rs`

- [ ] **Step 1: Write the failing Rust e2e test**

Add a test `cloud_self_messages_are_private_to_the_signed_in_account` to `bridges/cloud-server/tests/cloud_auth_e2e.rs`. It signs up two accounts, posts to `/v1/cloud/messages` with `peerAccountId` equal to the first account id, verifies `201`, lists the first account's self peer and sees the message, then lists that peer from the second account and sees an empty list.

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p kordi-cloud-server --test cloud_auth_e2e cloud_self_messages_are_private_to_the_signed_in_account -- --nocapture`

Expected: FAIL with `self_message`/`400 BAD_REQUEST` because self sends are rejected.

- [ ] **Step 3: Implement minimal server change**

In `send_message`, remove the `peer == session.account_id` rejection. Keep contact gating for non-self sends by changing the contact check to only require mutual contact when `peer != session.account_id && cloud_message_requires_accepted_contact(&body)`.

In `mark_messages_read`, return `204 NO_CONTENT` for `peer == session.account_id` because self messages do not need a read-state transition.

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p kordi-cloud-server --test cloud_auth_e2e cloud_self_messages_are_private_to_the_signed_in_account -- --nocapture`

Expected: PASS.

- [ ] **Step 5: Commit**

Run: `git add bridges/cloud-server/src/auth/routes.rs bridges/cloud-server/tests/cloud_auth_e2e.rs && git commit -m "fix(cloud): allow private self-agent message sync"`

### Task 2: Restore self-agent Cloud conversations from stored self messages

**Files:**
- Modify: `app/desktop/src/features/cloud/cloudBridgeState.ts`
- Modify: `app/desktop/src/features/cloud/useCloudBridgeState.ts`
- Modify: `app/desktop/tests/cloudBridgeState.test.tsx`

- [ ] **Step 1: Write failing TypeScript tests**

Add tests to `app/desktop/tests/cloudBridgeState.test.tsx` that assert:

1. `cloudBootstrapPeerIds(account, ['acct_peer'], [])` includes `acct_me`.
2. `buildCloudDesktopBridgeState({ account, contacts: [], messagesByPeer: { acct_me: [...] }, activeConversationId: null })` creates one `bridge:cloud:acct_me` conversation titled `My Kordi` with `peerRuntime === 'kordi-desktop'` and the stored self message.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --dir app/desktop test:unit --test-name-pattern "self-agent|bootstrap"`

Expected: FAIL because there is no exported `cloudBootstrapPeerIds` helper and self messages do not synthesize a conversation.

- [ ] **Step 3: Implement minimal desktop change**

In `cloudBridgeState.ts`, add a private self-contact helper for the signed-in account and build conversations from `selfContact + directContacts`, while keeping `buildCloudBridgeHost` visible peers based only on real contacts. For self peer, create only the agent conversation when messages exist or the agent conversation is active, title it `My Kordi`, and set local/remote agent identity fields to `cloud-local-agent` / `My Kordi`.

In `useCloudBridgeState.ts`, export `cloudBootstrapPeerIds(account, contactPeerIds, groupParticipantPeerIds, requests)` and use it in the `bootstrapPeerIds` memo so the signed-in account id is always queried for self-chat history.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --dir app/desktop test:unit --test-name-pattern "self-agent|bootstrap"`

Expected: PASS.

- [ ] **Step 5: Commit**

Run: `git add app/desktop/src/features/cloud/cloudBridgeState.ts app/desktop/src/features/cloud/useCloudBridgeState.ts app/desktop/tests/cloudBridgeState.test.tsx && git commit -m "fix(cloud): restore private self-agent chats"`

### Task 3: Full verification

**Files:**
- No code changes unless verification reveals a regression.

- [ ] **Step 1: Run frontend unit tests**

Run: `pnpm --dir app/desktop test:unit`

Expected: all tests pass.

- [ ] **Step 2: Run Cloud server e2e tests**

Run: `cargo test -p kordi-cloud-server --test cloud_auth_e2e`

Expected: all tests pass.

- [ ] **Step 3: Check final git state**

Run: `git status --short --branch`

Expected: branch `fix/issue-406-private-agent-history` with no uncommitted code changes except intentionally untracked local artifacts, if any.
