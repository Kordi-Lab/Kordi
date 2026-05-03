# Canonical Session Identity Helper Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce `app/desktop/src-tauri/src/canonical_sessions.rs` by extracting canonical identity/session request helper functions without changing persistence behavior.

**Architecture:** Add `app/desktop/src-tauri/src/canonical_sessions/identity_helpers.rs` for stable session id derivation, identity display-name lookups, receiver/title helpers, optional/status/json normalization, and canonical identity/avatar id derivation. Re-export the helpers from the root module so existing child modules keep their current imports.

**Tech Stack:** Rust Tauri desktop crate, `rusqlite`, canonical session DTOs, existing canonical session tests.

---

### Task 1: Extract identity/session request helpers

**Files:**
- Modify: `app/desktop/src-tauri/src/canonical_sessions.rs`
- Create: `app/desktop/src-tauri/src/canonical_sessions/identity_helpers.rs`
- Modify: `docs/development/maintainability-boundaries.md`

- [x] **Step 1: Write the failing module-boundary test**

Add a temporary/root test in `app/desktop/src-tauri/src/canonical_sessions/tests.rs` that references `super::identity_helpers::clean_optional(Some("  Shuyang  ".to_string()))` and expects `Some("Shuyang".to_string())`.

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
cargo test -p kordi-desktop canonical_sessions::tests::identity_helpers_module_trims_optional_values --no-default-features
```

Expected: FAIL with unresolved/private `identity_helpers` module/symbol error.

- [x] **Step 3: Move helpers into child module**

Create `app/desktop/src-tauri/src/canonical_sessions/identity_helpers.rs` and move:

- `stable_session_id`
- `identity_display_name`
- `shared_agent_display_name`
- `receiver_identity_ids`
- `default_session_title`
- `clean_optional`
- `validate_identity_kind`
- `validate_session_kind`
- `validate_status`
- `json_to_db`
- `json_from_db`
- `canonical_identity_id`
- `canonical_avatar_key`

Expose helpers as `pub(crate)` where they are used by existing child modules and as `pub(super)` for root-only helpers.

- [x] **Step 4: Move module-boundary test**

Move the Step 1 temporary/root test into `identity_helpers.rs`.

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
git add app/desktop/src-tauri/src/canonical_sessions.rs app/desktop/src-tauri/src/canonical_sessions/identity_helpers.rs docs/development/maintainability-boundaries.md docs/superpowers/plans/2026-05-03-canonical-session-identity-helper-split.md
git commit -m "Extract canonical session identity helpers"
```
