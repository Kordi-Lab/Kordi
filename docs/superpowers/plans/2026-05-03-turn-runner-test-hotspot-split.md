# Turn Runner Test Hotspot Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Reduce `agent/crates/cli/src/turn_runner/tests.rs` below the large-test threshold by moving scenario tests into child modules while keeping shared fake providers/tools in the root test module.

**Architecture:** Keep `turn_runner.rs` loading `tests.rs`. Keep the large shared fakes and helper builders in `tests.rs`; add child modules under `agent/crates/cli/src/turn_runner/tests/` that import `super::*` and preserve every test body/name.

**Tech Stack:** Rust async unit tests, `tokio::test`, `cargo fmt`, `cargo test -p kordi-cli turn_runner --no-default-features`.

---

### Task 1: Split turn runner scenario tests by domain

**Files:**
- Modify: `agent/crates/cli/src/turn_runner/tests.rs`
- Create: `agent/crates/cli/src/turn_runner/tests/provider_failures.rs`
- Create: `agent/crates/cli/src/turn_runner/tests/tool_execution.rs`
- Create: `agent/crates/cli/src/turn_runner/tests/compaction.rs`

- [x] **Step 1: Capture baseline test names**

Run:
```bash
cd /Users/shuyang/kordi-worktrees/issue-235-maintainability-boundaries
rg '^async fn ' agent/crates/cli/src/turn_runner/tests.rs -n
```
Expected: the file includes the existing async tests from `run_turn_retries_retryable_stream_provider_errors_before_failing_the_turn` through `run_turn_writes_request_metrics_log_when_path_is_configured`.

- [x] **Step 2: Add child module declarations**

Add these declarations after the shared helper functions in `agent/crates/cli/src/turn_runner/tests.rs`:
```rust
mod compaction;
mod provider_failures;
mod tool_execution;
```

- [x] **Step 3: Move provider failure and metrics tests**

Create `agent/crates/cli/src/turn_runner/tests/provider_failures.rs` with:
```rust
use super::*;
```
Then move these unchanged tests from `tests.rs` into it:
- `run_turn_retries_retryable_stream_provider_errors_before_failing_the_turn`
- `run_turn_reports_local_model_overload_when_stream_stalls`
- `run_turn_writes_request_metrics_log_when_path_is_configured`

- [x] **Step 4: Move tool execution tests**

Create `agent/crates/cli/src/turn_runner/tests/tool_execution.rs` with:
```rust
use super::*;
```
Then move these unchanged tests from `tests.rs` into it:
- `run_turn_contains_tool_panics_without_aborting_the_turn`
- `run_turn_continues_after_error_tool_results_when_provider_needs_error_flag`
- `run_turn_normalizes_builtin_tool_aliases_before_lookup`
- `cancelled_turn_with_tool_calls_persists_cancelled_tool_results`
- `read_only_tool_calls_can_overlap_in_real_turn_execution`
- `same_file_mutations_stay_serialized_in_real_turn_execution`

- [x] **Step 5: Move compaction tests**

Create `agent/crates/cli/src/turn_runner/tests/compaction.rs` with:
```rust
use super::*;
```
Then move these unchanged tests from `tests.rs` into it:
- `overflow_recovery_compacts_only_active_path_context`
- `run_turn_auto_compacts_at_ninety_percent_before_provider_request`
- `run_turn_stops_when_required_auto_compaction_fails`

- [x] **Step 6: Verify Rust test split**

Run:
```bash
cargo fmt --all -- --check
cargo test -p kordi-cli turn_runner --no-default-features
pnpm maintainability:scan -- --min-lines 1000 --limit 12
git diff --check
```
Expected: formatting passes, turn runner tests pass, and the maintainability scan no longer lists `agent/crates/cli/src/turn_runner/tests.rs`.

- [x] **Step 7: Commit the test split**

Run:
```bash
git add agent/crates/cli/src/turn_runner/tests.rs agent/crates/cli/src/turn_runner/tests docs/superpowers/plans/2026-05-03-turn-runner-test-hotspot-split.md
git commit -m "Split turn runner test modules"
```
