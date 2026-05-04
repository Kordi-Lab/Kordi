# Bridge Mailbox Test and Parse Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring `app/desktop/src-tauri/src/bridge/mailbox.rs` below the 1,000-line scan threshold by moving inline tests and the mailbox-event parser out of the orchestration root.

**Architecture:** Keep public/internal command paths stable by re-exporting `parse_mailbox_event` from `mailbox.rs` after moving its implementation into `bridge/mailbox_events.rs`. Move the inline `#[cfg(test)] mod tests` body to `bridge/mailbox/tests.rs` while preserving the module path `bridge::mailbox::tests::*`.

**Tech Stack:** Rust Tauri desktop crate, Bridge mailbox tests.

---

### Task 1: Split tests and parser helper

**Files:**
- Modify: `app/desktop/src-tauri/src/bridge/mailbox.rs`
- Modify: `app/desktop/src-tauri/src/bridge/mailbox_events.rs`
- Create: `app/desktop/src-tauri/src/bridge/mailbox/tests.rs`
- Modify: `docs/development/maintainability-boundaries.md`

- [x] **Step 1: Write the failing test-module boundary**

Replace the inline tests with `#[cfg(test)] mod tests;` before creating the backing file.

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
cargo test -p kordi-desktop bridge::mailbox::tests::mailbox_poll_uses_legacy_drain_only_when_ack_endpoint_is_missing --no-default-features
```

Expected: FAIL with `file not found for module tests`.

- [x] **Step 3: Move tests to file module**

Create `app/desktop/src-tauri/src/bridge/mailbox/tests.rs` with the previous inline test body, preserving test names and module path.

- [x] **Step 4: Move parse helper into mailbox_events**

Move `parse_mailbox_event` into `mailbox_events.rs` and re-export it from `mailbox.rs` so `conversation_commands.rs` keeps its existing import path.

- [x] **Step 5: Run targeted tests**

Run:

```bash
cargo test -p kordi-desktop bridge::mailbox --no-default-features
cargo test -p kordi-desktop bridge::conversation_commands::tests::parse_mailbox_event_decodes_valid_payload --no-default-features
```

Expected: all targeted tests pass.

- [x] **Step 6: Run slice verification and commit**

Run:

```bash
cargo fmt --all -- --check
cargo test -p kordi-desktop bridge::mailbox --no-default-features
cargo test -p kordi-desktop bridge::conversation_commands::tests::parse_mailbox_event_decodes_valid_payload --no-default-features
pnpm maintainability:scan -- --min-lines 1000 --limit 20
git diff --check
git add app/desktop/src-tauri/src/bridge/mailbox.rs app/desktop/src-tauri/src/bridge/mailbox_events.rs app/desktop/src-tauri/src/bridge/mailbox/tests.rs docs/development/maintainability-boundaries.md docs/superpowers/plans/2026-05-03-bridge-mailbox-test-parse-split.md
git commit -m "Split bridge mailbox tests and parser"
```
