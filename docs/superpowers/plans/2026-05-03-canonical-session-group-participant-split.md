# Canonical Session Group Participant Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring `app/desktop/src-tauri/src/canonical_sessions.rs` below the 1,000-line scan threshold by extracting group participant/admin mutation helpers.

**Architecture:** Add `app/desktop/src-tauri/src/canonical_sessions/group_participants.rs` for group session validation, rename/metadata/member mutation helpers, admin resolution, admin authorization, and active-participant checks. Re-export the helpers from the root module so existing command, parent-session, and test modules keep their current imports.

**Tech Stack:** Rust Tauri desktop crate, `rusqlite`, canonical session DTOs, existing canonical session tests.

---

### Task 1: Extract group participant/admin helpers

**Files:**
- Modify: `app/desktop/src-tauri/src/canonical_sessions.rs`
- Create: `app/desktop/src-tauri/src/canonical_sessions/group_participants.rs`
- Modify: `docs/development/maintainability-boundaries.md`

- [x] **Step 1: Write the failing module-boundary test**

Add a temporary/root test in `app/desktop/src-tauri/src/canonical_sessions/tests.rs` that references `super::group_participants::metadata_admin_identity_ids(Some(&serde_json::json!({"adminIdentityIds": ["human:a", " "]})))` and expects `vec!["human:a".to_string()]`.

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
cargo test -p kordi-desktop canonical_sessions::tests::group_participants_module_filters_metadata_admin_ids --no-default-features
```

Expected: FAIL with unresolved/private `group_participants` module/symbol error.

- [x] **Step 3: Move group participant helpers into child module**

Create `app/desktop/src-tauri/src/canonical_sessions/group_participants.rs` and move:

- `ensure_group_session`
- `rename_session_in_db`
- `set_session_metadata_in_db`
- `add_session_participants_in_db`
- `metadata_admin_identity_ids`
- `participant_is_active`
- `group_admin_identity_ids`
- `require_group_admin`
- `set_session_participant_role_in_db`
- `remove_session_participant_in_db`
- `session_has_participant`

Expose helpers as `pub(crate)` because command/parent/test modules import them through the root.

- [x] **Step 4: Move module-boundary test**

Move the Step 1 temporary/root test into `group_participants.rs`.

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
git add app/desktop/src-tauri/src/canonical_sessions.rs app/desktop/src-tauri/src/canonical_sessions/group_participants.rs docs/development/maintainability-boundaries.md docs/superpowers/plans/2026-05-03-canonical-session-group-participant-split.md
git commit -m "Extract canonical session group participant helpers"
```
