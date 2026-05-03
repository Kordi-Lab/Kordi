# Bridge Agent Response Timeout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface a visible, persisted failure when a Bridge group agent mention is delivered but no agent response/failure returns.

**Architecture:** Keep #225 group delivery semantics for user bubbles. Add a synthetic canonical agent-turn for Bridge agent `session-message` requests: `processing` while fresh, `processing_failed` after a timeout. Empty mailbox polls should still run canonical sync once a timeout is due so the failure persists without requiring new messages.

**Tech Stack:** Rust/Tauri backend, SQLite canonical sessions, existing TypeScript canonical read model.

---

### Task 1: Add backend timeout regression coverage

**Files:**
- Modify: `app/desktop/src-tauri/src/canonical_sessions/tests.rs`

- [x] Add a failing Rust test that syncs an outbound group `bridge-agent` session-message with an old `sent` Bridge message and no response.
- [x] Assert the canonical parent transcript contains the original user row plus an `external-agent` `agent-turn` with `status = failed`, `content.deliveryState = processing_failed`, and generic timeout text.
- [x] Run: `cd app/desktop/src-tauri && cargo test canonical_sessions::tests::outbound_group_bridge_agent_session_message_without_response_times_out -- --nocapture`
- [x] Expected before implementation: FAIL because no timeout agent-turn is written.

### Task 2: Add synthetic processing/timeout agent-turns

**Files:**
- Modify: `app/desktop/src-tauri/src/bridge/constants.rs`
- Modify: `app/desktop/src-tauri/src/canonical_sessions/parent_sessions/relay.rs`

- [x] Add `BRIDGE_AGENT_SESSION_MESSAGE_TIMEOUT_MS = 90_000`.
- [x] In `sync_parent_session_relay_messages`, when an outbound `session-message` targets `bridge-agent` and has no matching response, append/reconcile a stable synthetic agent-turn using source id `agent-response:<requestId>`.
- [x] Use `deliveryState = processing` before timeout and `processing_failed` after timeout.
- [x] Use the remote agent identity as sender and `external-agent` role.
- [x] Verify the targeted Rust test passes.

### Task 3: Trigger timeout sync on empty mailbox polls

**Files:**
- Modify: `app/desktop/src-tauri/src/bridge/conversation_actions.rs`
- Test: existing/added Rust unit tests in `conversation_actions.rs` if helper is unit-testable.

- [x] Add a helper that detects due Bridge agent session-message timeouts from stored Bridge conversation messages.
- [x] In `rebuild_state_after_mailbox_poll`, canonical-sync when either storage changed or a timeout is due.
- [x] Add a unit test for due vs not-due timeout detection.

### Task 4: Add read-model guard coverage

**Files:**
- Modify: `app/desktop/tests/chatRouting.test.tsx`

- [x] Add/extend a test that maps a `desktop-bridge-parent` failed external-agent turn and verifies the UI model shows a failed turn without leaking detail.
- [x] Run: `pnpm --dir app/desktop exec tsx --test tests/chatRouting.test.tsx`

### Task 5: Final verification and commit

- [x] Run targeted Rust tests.
- [x] Run targeted TS tests.
- [x] Run full desktop unit tests, typecheck, lint, build, cargo fmt check, cargo test --lib, and diff checks.
- [x] Commit with message `Fix silent Bridge agent response timeouts`.
