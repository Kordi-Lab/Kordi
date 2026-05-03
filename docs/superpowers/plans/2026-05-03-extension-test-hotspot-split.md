# Extension Test Hotspot Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Reduce `agent/crates/cli/src/extensions/tests.rs` below the large-test threshold by moving extension parsing, package resource, and command/runtime scenarios into child modules.

**Architecture:** Keep `extensions/mod.rs` loading `tests.rs`. Keep shared imports and `node_available()` in the root test module; add child modules under `agent/crates/cli/src/extensions/tests/` that import `super::*` and preserve test names/bodies.

**Tech Stack:** Rust unit tests, async `tokio::test`, `cargo fmt`, `cargo test -p kordi-cli extensions --no-default-features`.

---

### Task 1: Split extension tests by domain

**Files:**
- Modify: `agent/crates/cli/src/extensions/tests.rs`
- Create: `agent/crates/cli/src/extensions/tests/parsing.rs`
- Create: `agent/crates/cli/src/extensions/tests/package_resources.rs`
- Create: `agent/crates/cli/src/extensions/tests/command_runtime.rs`

- [x] **Step 1: Capture baseline test names**

Run:
```bash
cd /Users/shuyang/kordi-worktrees/issue-235-maintainability-boundaries
rg '^(fn|async fn) ' agent/crates/cli/src/extensions/tests.rs -n
```
Expected: test names include `parses_frontmatter_name_and_description`, `package_loaded_extension_command_executes_with_context`, and `build_skill_section_empty_when_no_resources`.

- [x] **Step 2: Add child module declarations**

Add these declarations after `node_available()` in `agent/crates/cli/src/extensions/tests.rs`:
```rust
mod command_runtime;
mod package_resources;
mod parsing;
```

- [x] **Step 3: Move parsing and result tests**

Create `agent/crates/cli/src/extensions/tests/parsing.rs` with:
```rust
use super::*;
```
Move these unchanged tests into it:
- `parses_frontmatter_name_and_description`
- `parses_command_invocation_and_args`
- `input_hook_action_defaults_unknown_values_to_continue`
- `parses_extension_menu_result_with_items`
- `parses_extension_prompt_result_with_resume_token`
- `parses_dispatch_and_activate_agent_results`
- `non_menu_result_yields_text_or_nothing`
- `command_outcome_into_text_formats_non_tui_fallbacks`
- `plugin_tool_result_mapping_preserves_blocks_and_flags`
- `plugin_tool_result_mapping_falls_back_to_pretty_json_when_needed`
- `empty_plugin_runtime_returns_defaults`

- [x] **Step 4: Move package resource tests**

Create `agent/crates/cli/src/extensions/tests/package_resources.rs` with:
```rust
use super::*;
```
Move these unchanged tests into it:
- `classifies_package_sources`
- `extension_bootstrap_splits_package_sources_from_paths`
- `discovers_package_resources_from_manifest`
- `loads_package_skills_and_prompts_from_settings`
- `disabled_skills_are_excluded_from_runtime_resources`
- `project_scoped_package_settings_round_trip`
- `package_identity_controls_remove_and_listing`
- `update_skips_pinned_package_sources`
- `filter_matches_patterns`
- `filtered_package_loads_only_matching_resources`
- `auto_install_skips_local_and_already_installed`
- `resolve_package_directory_prefers_project_root_install_from_nested_cwd`
- `auto_install_identifies_missing_npm_package_dir`
- `build_skill_section_includes_skills_and_prompts`
- `build_skill_section_empty_when_no_resources`

- [x] **Step 5: Move command/runtime tests**

Create `agent/crates/cli/src/extensions/tests/command_runtime.rs` with:
```rust
use super::*;
```
Move these unchanged tests into it:
- `package_loaded_extension_command_executes_with_context`
- `extension_command_timeout_returns_error_instead_of_hanging`
- `reload_reloads_extension_command_output`
- `extension_ui_notify_and_confirm_plumbing`

- [x] **Step 6: Verify Rust test split**

Run:
```bash
cargo fmt --all -- --check
cargo test -p kordi-cli extensions --no-default-features
pnpm maintainability:scan -- --min-lines 1000 --limit 12
git diff --check
```
Expected: formatting passes, extension tests pass, and the maintainability scan no longer lists `agent/crates/cli/src/extensions/tests.rs`.

- [x] **Step 7: Commit the test split**

Run:
```bash
git add agent/crates/cli/src/extensions/tests.rs agent/crates/cli/src/extensions/tests docs/superpowers/plans/2026-05-03-extension-test-hotspot-split.md
git commit -m "Split extension test modules"
```
