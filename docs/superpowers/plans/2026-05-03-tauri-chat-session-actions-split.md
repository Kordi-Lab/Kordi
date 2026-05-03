# Tauri Chat Session Actions Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Reduce `app/desktop/src-tauri/src/chat.rs` by extracting session archive/delete/move helper logic while keeping Tauri command functions in place.

**Architecture:** Add `app/desktop/src-tauri/src/chat/session_actions.rs` for session-action target resolution, fallback active-session selection, home-path expansion, and project-root input resolution. Keep command macro functions in `chat.rs` and import the helpers.

**Tech Stack:** Rust Tauri desktop crate, desktop runtime session store helpers, canonical session existence checks, existing Rust unit tests.

---

### Task 1: Extract session action helpers

**Files:**
- Modify: `app/desktop/src-tauri/src/chat.rs`
- Create: `app/desktop/src-tauri/src/chat/session_actions.rs`
- Modify: `docs/development/maintainability-boundaries.md`

- [x] **Step 1: Write failing module-boundary test reference**

Added a test for `~/` project path expansion that referenced `session_actions::expand_home_project_path` before the module existed.

- [x] **Step 2: Run test to verify it fails**

Run: `cargo test -p kordi-desktop chat::tests::expand_home_project_path_uses_home_for_tilde_prefix --no-default-features`

Observed: FAIL with unresolved `session_actions` module/symbol error.

- [x] **Step 3: Move session-action helpers into child module**

Moved `SessionActionTarget`, existing-session target resolution, fallback active-session resolution, home path expansion, and project-root input resolution into `chat/session_actions.rs`.

- [x] **Step 4: Run targeted tests**

Run: `cargo test -p kordi-desktop chat::session_actions --no-default-features`

Observed: 1 test passed.

- [x] **Step 5: Run slice verification and commit**

Run:

```bash
cargo fmt --all -- --check
cargo test -p kordi-desktop chat --no-default-features
pnpm maintainability:scan -- --min-lines 1000 --limit 20
git diff --check
git add app/desktop/src-tauri/src/chat.rs app/desktop/src-tauri/src/chat/session_actions.rs docs/development/maintainability-boundaries.md docs/superpowers/plans/2026-05-03-tauri-chat-session-actions-split.md
git commit -m "Extract Tauri chat session action helpers"
```
