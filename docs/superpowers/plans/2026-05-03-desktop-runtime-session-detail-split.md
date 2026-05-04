# Desktop Runtime Session Detail Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce `agent/crates/cli/src/desktop_runtime.rs` by extracting session detail/profile projection helpers without changing desktop runtime APIs.

**Architecture:** Add `agent/crates/cli/src/desktop_runtime/session_detail.rs` for agent profile projection, session summary/detail assembly, cache/context-window status helpers, focus subtitle formatting, thinking labels, and timestamp labels. Keep `DesktopRuntimeSession` methods and session mutation/turn-running code in the root module, importing the projection helpers from the child module.

**Tech Stack:** Rust CLI crate, desktop runtime DTOs, `kordi_monitor`, existing desktop runtime tests.

---

### Task 1: Extract session detail/profile projection

**Files:**
- Modify: `agent/crates/cli/src/desktop_runtime.rs`
- Create: `agent/crates/cli/src/desktop_runtime/session_detail.rs`
- Modify: `docs/development/maintainability-boundaries.md`

- [x] **Step 1: Write the failing module-boundary test**

Add a temporary/root test in `agent/crates/cli/src/desktop_runtime.rs` that references `session_detail::thinking_label("xhigh")` and expects `"Extra High"`.

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
cargo test -p kordi-cli desktop_runtime::tests::session_detail_module_formats_xhigh_label --no-default-features
```

Expected: FAIL with unresolved `session_detail` module/symbol error.

- [x] **Step 3: Move projection helpers into child module**

Create `agent/crates/cli/src/desktop_runtime/session_detail.rs` and move:

- `discover_workspace_root`
- `repo_relative_display_path`
- `infer_agent_label`
- `collect_agent_identity_files`
- `build_agent_profile_from_setup`
- `build_summary_from_setup`
- `build_detail_from_setup`
- `current_auth_cache_metrics_source`
- `request_matches_cache_domain`
- `active_path_has_contextful_entries`
- `estimate_active_path_context_tokens`
- `current_cache_monitor_text`
- `current_context_window_status`
- `session_focus_subtitle`
- `thinking_label`
- `format_message_timestamp`
- `format_utc_timestamp`

Re-export `thinking_label`, `format_message_timestamp`, and `format_utc_timestamp` from the root module for the existing transcript child module.

- [x] **Step 4: Move module-boundary tests**

Move the Step 1 temporary/root test into `session_detail.rs`, and move the existing `local_desktop_agent_label_is_not_inferred_from_project_name` test into the new module.

- [x] **Step 5: Run targeted tests**

Run:

```bash
cargo test -p kordi-cli desktop_runtime --no-default-features
```

Expected: all desktop runtime tests pass.

- [x] **Step 6: Run slice verification and commit**

Run:

```bash
cargo fmt --all -- --check
cargo test -p kordi-cli desktop_runtime --no-default-features
pnpm maintainability:scan -- --min-lines 1000 --limit 20
git diff --check
git add agent/crates/cli/src/desktop_runtime.rs agent/crates/cli/src/desktop_runtime/session_detail.rs docs/development/maintainability-boundaries.md docs/superpowers/plans/2026-05-03-desktop-runtime-session-detail-split.md
git commit -m "Extract desktop runtime session detail projection"
```
