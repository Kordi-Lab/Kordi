# Tauri Chat Message Route Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce `app/desktop/src-tauri/src/chat.rs` by extracting desktop message route normalization/application helpers without changing send/start command behavior.

**Architecture:** Add `app/desktop/src-tauri/src/chat/message_route.rs` for route value normalization and applying model/auth/thinking choices to a desktop runtime session. Keep Tauri command functions in `chat.rs` and import the helper.

**Tech Stack:** Rust Tauri desktop crate, desktop runtime session, existing chat tests.

---

### Task 1: Extract message route helpers

**Files:**
- Modify: `app/desktop/src-tauri/src/chat.rs`
- Create: `app/desktop/src-tauri/src/chat/message_route.rs`
- Modify: `docs/development/maintainability-boundaries.md`

- [x] **Step 1: Write the failing module-boundary test**

Add a temporary/root test in `app/desktop/src-tauri/src/chat.rs` that references `message_route::normalized_message_route_value(Some(&"default".to_string()))` and expects `None`.

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
cargo test -p kordi-desktop chat::tests::message_route_module_treats_default_as_unset --no-default-features
```

Expected: FAIL with unresolved `message_route` module/symbol error.

- [x] **Step 3: Move message route helpers into child module**

Create `app/desktop/src-tauri/src/chat/message_route.rs` and move:

- `normalized_message_route_value`
- `apply_desktop_chat_message_route`

Expose `apply_desktop_chat_message_route` to the root chat module.

- [x] **Step 4: Move module-boundary test**

Move the Step 1 temporary/root test into `message_route.rs`.

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
git add app/desktop/src-tauri/src/chat.rs app/desktop/src-tauri/src/chat/message_route.rs docs/development/maintainability-boundaries.md docs/superpowers/plans/2026-05-03-tauri-chat-message-route-split.md
git commit -m "Extract Tauri chat message route helpers"
```
