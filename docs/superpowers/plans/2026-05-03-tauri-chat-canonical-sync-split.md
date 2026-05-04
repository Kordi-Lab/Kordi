# Tauri Chat Canonical Sync Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce `app/desktop/src-tauri/src/chat.rs` by extracting canonical-session sync projection helpers without changing desktop chat state or sync behavior.

**Architecture:** Add `app/desktop/src-tauri/src/chat/canonical_sync.rs` for completed desktop session projection and active-tail omission while live turns run. Keep Tauri command functions and state loading in `chat.rs`; import the sync helper from the child module.

**Tech Stack:** Rust Tauri desktop crate, canonical sessions module, desktop runtime DTOs, existing chat tests.

---

### Task 1: Extract canonical sync projection helpers

**Files:**
- Modify: `app/desktop/src-tauri/src/chat.rs`
- Create: `app/desktop/src-tauri/src/chat/canonical_sync.rs`
- Modify: `docs/development/maintainability-boundaries.md`

- [x] **Step 1: Write the failing module-boundary test**

Add a temporary/root test in `app/desktop/src-tauri/src/chat.rs` that references `canonical_sync::desktop_chat_message_is_agent(&DesktopChatMessage { role: "assistant".to_string(), ... })` and expects `true`.

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
cargo test -p kordi-desktop chat::tests::canonical_sync_module_detects_agent_messages --no-default-features
```

Expected: FAIL with unresolved `canonical_sync` module/symbol error.

- [x] **Step 3: Move canonical sync helpers into child module**

Create `app/desktop/src-tauri/src/chat/canonical_sync.rs` and move:

- `desktop_chat_message_is_agent`
- `completed_desktop_session_state_for_canonical_sync`
- `sync_completed_desktop_session_to_canonical`
- `desktop_state_for_canonical_sync`

Expose only `sync_completed_desktop_session_to_canonical` to the root chat module.

- [x] **Step 4: Move canonical sync tests**

Move these existing tests from root into `canonical_sync.rs`:

- `desktop_canonical_sync_state_omits_active_agent_tail_while_live_turn_runs`
- `completed_desktop_session_sync_state_preserves_agent_runtime_details`

Move the Step 1 temporary/root test into the new module or remove it once covered by the existing tests.

- [x] **Step 5: Run targeted tests**

Run:

```bash
cargo test -p kordi-desktop chat --no-default-features
```

Expected: all chat tests pass.

- [x] **Step 6: Run slice verification and commit**

Run:

```bash
cargo fmt --all -- --check
cargo test -p kordi-desktop chat --no-default-features
pnpm maintainability:scan -- --min-lines 1000 --limit 20
git diff --check
git add app/desktop/src-tauri/src/chat.rs app/desktop/src-tauri/src/chat/canonical_sync.rs docs/development/maintainability-boundaries.md docs/superpowers/plans/2026-05-03-tauri-chat-canonical-sync-split.md
git commit -m "Extract Tauri chat canonical sync helpers"
```
