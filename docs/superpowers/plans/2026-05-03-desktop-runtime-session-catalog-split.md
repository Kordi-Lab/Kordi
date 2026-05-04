# Desktop Runtime Session Catalog Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce `agent/crates/cli/src/desktop_runtime.rs` by extracting session title, session summary, and project-group catalog helpers into a focused module without changing public desktop runtime APIs.

**Architecture:** Add `agent/crates/cli/src/desktop_runtime/session_catalog.rs` for DB timestamp parsing, title repair, session summaries, project group listing, registered project creation, runtime cwd lookup, and project info loading. Keep root public functions by re-exporting/wrapping the module functions from `desktop_runtime.rs`.

**Tech Stack:** Rust `kordi-cli`, `kordi_session` store APIs, desktop runtime DTOs, existing Rust unit tests.

---

### Task 1: Extract session catalog helpers

**Files:**
- Modify: `agent/crates/cli/src/desktop_runtime.rs`
- Create: `agent/crates/cli/src/desktop_runtime/session_catalog.rs`
- Modify: `docs/development/maintainability-boundaries.md`

- [x] **Step 1: Write the failing module-boundary test reference**

In `agent/crates/cli/src/desktop_runtime.rs`, update `session_title_seed_matches_chat_title_rules` and `placeholder_session_names_are_not_real_titles` to call `session_catalog::session_title_from_seed` and `session_catalog::session_row_display_name`. This proves the new module boundary before it exists.

- [x] **Step 2: Run test to verify it fails**

Run: `cargo test -p kordi-cli desktop_runtime::tests::session_title_seed_matches_chat_title_rules --no-default-features`

Expected: FAIL with an unresolved `session_catalog` module/symbol error.

- [x] **Step 3: Move catalog implementation into child module**

Create `agent/crates/cli/src/desktop_runtime/session_catalog.rs` with:
- DB timestamp and activity helpers
- `session_row_display_name`
- `session_title_from_seed`
- `session_title_from_messages`
- `repair_session_title_from_history`
- `session_summary_from_row`
- `open_sessions_db`
- `runtime_cwd_for_session`
- `list_session_summaries`
- `project_group_id`
- `exact_project_settings`
- `project_group_from_root`
- `register_project`
- `list_project_groups`
- `load_project_info`
- moved session title/name tests

In `agent/crates/cli/src/desktop_runtime.rs`:
- add `mod session_catalog;`
- import the module functions used by root code.
- remove moved catalog helpers/tests.

- [x] **Step 4: Run targeted tests**

Run: `cargo test -p kordi-cli desktop_runtime::session_catalog --no-default-features`

Expected: session catalog tests PASS.

- [x] **Step 5: Update maintainability docs**

Update `docs/development/maintainability-boundaries.md`:
- Desktop Rust runtime disposition should mention session catalog extraction.
- Completed slices should include the session catalog split.

- [x] **Step 6: Run slice verification**

Run:

```bash
cargo fmt --all -- --check
cargo test -p kordi-cli desktop_runtime --no-default-features
pnpm maintainability:scan -- --min-lines 1000 --limit 20
git diff --check
```

Expected: desktop runtime tests PASS; formatting and whitespace checks pass; scan shows `desktop_runtime.rs` reduced.

- [ ] **Step 7: Commit**

Run:

```bash
git add agent/crates/cli/src/desktop_runtime.rs agent/crates/cli/src/desktop_runtime/session_catalog.rs docs/development/maintainability-boundaries.md docs/superpowers/plans/2026-05-03-desktop-runtime-session-catalog-split.md
git commit -m "Extract desktop runtime session catalog"
```
