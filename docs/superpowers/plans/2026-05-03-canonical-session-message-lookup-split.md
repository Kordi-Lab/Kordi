# Canonical Session Message Lookup Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring `app/desktop/src-tauri/src/canonical_sessions.rs` below the 1,000-line scan threshold by extracting message lookup/dedup helpers.

**Architecture:** Add `app/desktop/src-tauri/src/canonical_sessions/message_lookup.rs` for similar agent-message matching, delegation join lookup, and session message count helpers. Re-export helpers from the root module for existing parent-session modules.

**Tech Stack:** Rust Tauri desktop crate, `rusqlite`, existing canonical session tests.

---

### Task 1: Extract message lookup helpers

**Files:**
- Modify: `app/desktop/src-tauri/src/canonical_sessions.rs`
- Create: `app/desktop/src-tauri/src/canonical_sessions/message_lookup.rs`
- Modify: `docs/development/maintainability-boundaries.md`

- [x] **Step 1: Write the failing module-boundary test**

Add a temporary/root test in `app/desktop/src-tauri/src/canonical_sessions/tests.rs` that references `super::message_lookup::similar_agent_message_text("hello world", "hello\nworld")` and expects `true`.

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
cargo test -p kordi-desktop canonical_sessions::tests::message_lookup_module_matches_compacted_agent_text --no-default-features
```

Expected: FAIL with unresolved/private `message_lookup` module/symbol error.

- [x] **Step 3: Move message lookup helpers into child module**

Create `app/desktop/src-tauri/src/canonical_sessions/message_lookup.rs` and move:

- `compact_agent_message_text`
- `similar_agent_message_text`
- `similar_agent_message_exists`
- `existing_delegation_join_message_id`
- `session_message_count`

Expose externally used helpers as `pub(crate)`.

- [x] **Step 4: Move module-boundary test**

Move the Step 1 temporary/root test into `message_lookup.rs`.

- [x] **Step 5: Run targeted tests**

Run:

```bash
cargo test -p kordi-desktop canonical_sessions --no-default-features
```

Expected: all canonical session tests pass.

- [x] **Step 6: Run slice verification and commit**

Run:

```bash
cargo fmt --all -- --check
cargo test -p kordi-desktop canonical_sessions --no-default-features
pnpm maintainability:scan -- --min-lines 1000 --limit 20
git diff --check
git add app/desktop/src-tauri/src/canonical_sessions.rs app/desktop/src-tauri/src/canonical_sessions/message_lookup.rs docs/development/maintainability-boundaries.md docs/superpowers/plans/2026-05-03-canonical-session-message-lookup-split.md
git commit -m "Extract canonical session message lookup helpers"
```
