# Bridges Local API Message Handlers Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce `bridges/cli/src/local_api.rs` by extracting send/ask/broadcast/debate/publish route DTOs and handlers without changing URLs, JSON shapes, or delivery semantics.

**Architecture:** Add `bridges/cli/src/local_api/messages.rs` as a child module. Keep router construction, transport encryption, peer/status handlers, and public daemon state in `local_api.rs`; move message request/response DTOs, the default message type helper, and the five message route handlers into the child module.

**Tech Stack:** Rust Bridges CLI crate, Axum route handlers, existing local API tests.

---

### Task 1: Extract local API message handlers

**Files:**
- Modify: `bridges/cli/src/local_api.rs`
- Create: `bridges/cli/src/local_api/messages.rs`
- Modify: `docs/development/maintainability-boundaries.md`

- [x] **Step 1: Write the failing module-boundary test**

Add a temporary/root test in `bridges/cli/src/local_api.rs` that references `messages::default_message_type()` and expects `"broadcast"`.

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
cargo test -p bridges local_api::tests::messages_module_preserves_default_broadcast_type --no-default-features
```

Expected: FAIL with unresolved `messages` module/symbol error.

- [x] **Step 3: Move message DTOs and handlers into child module**

Create `bridges/cli/src/local_api/messages.rs` and move:

- `SendRequest`
- `SendResponse`
- `AskRequest`
- `BroadcastRequest`
- `default_message_type`
- `DebateRequest`
- `PublishRequest`
- `BroadcastResponse`
- `handle_send`
- `handle_ask`
- `handle_broadcast`
- `handle_debate`
- `handle_publish`

Expose the handlers and DTOs used by root tests as `pub(super)`; keep the delivery semantics comments with their handlers.

- [x] **Step 4: Move module-boundary test**

Move the Step 1 temporary/root test into `messages.rs` so the default message type coverage lives with the extracted helper.

- [x] **Step 5: Run targeted tests**

Run:

```bash
cargo test -p bridges local_api --no-default-features
```

Expected: all local API tests pass.

- [x] **Step 6: Run slice verification and commit**

Run:

```bash
cargo fmt --all -- --check
cargo test -p bridges local_api --no-default-features
pnpm maintainability:scan -- --min-lines 1000 --limit 20
git diff --check
git add bridges/cli/src/local_api.rs bridges/cli/src/local_api/messages.rs docs/development/maintainability-boundaries.md docs/superpowers/plans/2026-05-03-bridges-local-api-message-handlers-split.md
git commit -m "Extract bridges local API message handlers"
```
