# Desktop Runtime Model Options Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Reduce `agent/crates/cli/src/desktop_runtime.rs` by moving model option caching, model resolution, and thinking-control helpers into a focused sibling module.

**Architecture:** Keep DTOs and session lifecycle in `desktop_runtime.rs`. Move model-option cache state, authenticated model option loading, model candidate resolution, auth-choice resolution, and thinking-level normalization into `agent/crates/cli/src/desktop_runtime/model_options.rs`; re-export public functions from `desktop_runtime.rs` so callers keep the same API.

**Tech Stack:** Rust, existing desktop runtime tests, `cargo fmt`, `cargo test -p kordi-cli desktop_runtime --no-default-features`.

---

### Task 1: Extract desktop runtime model option helpers

**Files:**
- Modify: `agent/crates/cli/src/desktop_runtime.rs`
- Create: `agent/crates/cli/src/desktop_runtime/model_options.rs`

- [x] **Step 1: Capture baseline helper/test coverage**

Run:
```bash
cd /Users/shuyang/kordi-worktrees/issue-235-maintainability-boundaries
cargo test -p kordi-cli desktop_runtime --no-default-features
```
Expected: desktop runtime tests pass, including thinking/model-selection tests.

- [x] **Step 2: Move model option cache and thinking helpers**

Create `agent/crates/cli/src/desktop_runtime/model_options.rs` and move these unchanged responsibilities from `desktop_runtime.rs`:
- `DESKTOP_MODEL_OPTIONS_CACHE_TTL`, `DESKTOP_MODEL_OPTIONS_CACHE`, `desktop_model_options_cache`, `clear_desktop_model_options_cache`, `desktop_model_options_cache_key`
- thinking-level constants, `ThinkingControlMode`, local/remote thinking helper functions
- `desktop_thinking_levels_for_model`, `desktop_thinking_levels_for_model_id`
- `normalize_setup_thinking`, `request_thinking_for_model`, `effective_thinking_for_model`
- `desktop_model_option_from_model`, `authenticated_model_options`
- `synthesize_live_model_candidate`, `resolve_model_candidate`, `resolve_auth_choice_override_for_model`

Use direct imports in the new module for `anyhow`, `ThinkingLevel`, `Settings`, `Model`, `ModelRegistry`, `SessionRuntimeSetup`, `SessionAuthChoiceOverride`, `prepare_session_runtime_for_cwd`, `login`, cache synchronization types, and `DesktopChatModelOption`.

- [x] **Step 3: Re-export stable public functions and import internal helpers**

In `desktop_runtime.rs`, add:
```rust
mod model_options;

pub use model_options::{
    authenticated_model_options,
    clear_desktop_model_options_cache,
    desktop_thinking_levels_for_model,
    desktop_thinking_levels_for_model_id,
};

use model_options::{
    effective_thinking_for_model,
    normalize_setup_thinking,
    request_thinking_for_model,
    resolve_auth_choice_override_for_model,
    resolve_model_candidate,
};
```
Remove imports that are only needed by the new module.

- [x] **Step 4: Verify Rust runtime split**

Run:
```bash
cargo fmt --all -- --check
cargo test -p kordi-cli desktop_runtime --no-default-features
pnpm maintainability:scan -- --min-lines 1000 --limit 12
git diff --check
```
Expected: formatting and desktop runtime tests pass; maintainability scan reports a smaller `agent/crates/cli/src/desktop_runtime.rs`.

- [x] **Step 5: Commit the extraction**

Run:
```bash
git add agent/crates/cli/src/desktop_runtime.rs agent/crates/cli/src/desktop_runtime/model_options.rs docs/superpowers/plans/2026-05-03-desktop-runtime-model-options-split.md
git commit -m "Extract desktop runtime model options"
```
