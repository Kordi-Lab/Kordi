# Bridge Mailbox Event Helper Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce `app/desktop/src-tauri/src/bridge/mailbox.rs` by extracting mailbox event/thread helper functions without changing mailbox processing behavior.

**Architecture:** Add `app/desktop/src-tauri/src/bridge/mailbox_events.rs` for response-done checks, processing-placeholder detection, partial-response buffering decisions, session-thread metadata helpers, group relay target extraction, and response payload shaping. Keep mailbox polling/execution orchestration in `mailbox.rs`.

**Tech Stack:** Rust Tauri desktop crate, Bridge mailbox events, existing mailbox tests.

---

### Task 1: Extract mailbox event/thread helpers

**Files:**
- Modify: `app/desktop/src-tauri/src/bridge/mailbox.rs`
- Create: `app/desktop/src-tauri/src/bridge/mailbox_events.rs`
- Modify: `app/desktop/src-tauri/src/bridge/mod.rs`
- Modify: `docs/development/maintainability-boundaries.md`

- [x] **Step 1: Write the failing module-boundary test**

Add a temporary/root test in `app/desktop/src-tauri/src/bridge/mailbox.rs` that references `super::mailbox_events::is_processing_placeholder_text("processing…")` and expects `true`.

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
cargo test -p kordi-desktop bridge::mailbox::tests::mailbox_events_module_detects_processing_placeholder --no-default-features
```

Expected: FAIL with unresolved/private `mailbox_events` module/symbol error.

- [x] **Step 3: Move helpers into child module**

Create `app/desktop/src-tauri/src/bridge/mailbox_events.rs` and move:

- `bridge_response_is_done`
- `is_processing_placeholder_text`
- `should_buffer_partial_agent_response`
- `event_session_thread`
- `event_session_thread_target_kind`
- `event_session_thread_has_parent_turn`
- `event_targets_group_session`
- `group_session_thread_relay_targets`
- `bridge_response_payload`

Declare `mod mailbox_events;` in `bridge/mod.rs` and import helpers into `mailbox.rs`.

- [x] **Step 4: Move module-boundary test**

Move the Step 1 temporary/root test into `mailbox_events.rs`.

- [x] **Step 5: Run targeted tests**

Run:

```bash
cargo test -p kordi-desktop bridge::mailbox --no-default-features
```

Expected: all mailbox tests pass.

- [x] **Step 6: Run slice verification and commit**

Run:

```bash
cargo fmt --all -- --check
cargo test -p kordi-desktop bridge::mailbox --no-default-features
pnpm maintainability:scan -- --min-lines 1000 --limit 20
git diff --check
git add app/desktop/src-tauri/src/bridge/mailbox.rs app/desktop/src-tauri/src/bridge/mailbox_events.rs app/desktop/src-tauri/src/bridge/mod.rs docs/development/maintainability-boundaries.md docs/superpowers/plans/2026-05-03-bridge-mailbox-event-helper-split.md
git commit -m "Extract bridge mailbox event helpers"
```
