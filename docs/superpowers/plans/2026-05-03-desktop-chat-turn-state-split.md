# Desktop Chat Turn State Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Reduce `app/desktop/src-tauri/src/chat.rs` by moving live-turn snapshot/event helpers into a focused sibling module without changing Tauri command names or DTOs.

**Architecture:** Keep `DesktopChatManager`, Tauri command handlers, DTO structs, and session orchestration in `chat.rs`. Move turn snapshot locking, turn event application, running-turn pruning, and tool-output helper functions to `app/desktop/src-tauri/src/chat/turns.rs`; import them back into `chat.rs` as `pub(super)` helpers.

**Tech Stack:** Rust/Tauri unit tests, `cargo fmt`, `cargo test -p kordi-desktop --no-default-features`.

---

### Task 1: Extract desktop chat turn state helpers

**Files:**
- Modify: `app/desktop/src-tauri/src/chat.rs`
- Create: `app/desktop/src-tauri/src/chat/turns.rs`

- [x] **Step 1: Capture baseline desktop chat tests**

Run:
```bash
cd /Users/shuyang/kordi-worktrees/issue-235-maintainability-boundaries
cargo test -p kordi-desktop chat --no-default-features
```
Expected: chat tests pass, including auto-compaction status and running-turn lookup tests.

- [x] **Step 2: Move turn state helpers**

Create `app/desktop/src-tauri/src/chat/turns.rs` and move these functions unchanged from `chat.rs`:
- `snapshot_turn`
- `update_turn`
- `is_auto_compaction_success_status`
- `is_auto_compaction_failure_status`
- `apply_desktop_turn_event`
- `turn_matches_running_session`
- `prune_finished_turns`
- `session_has_running_turn`
- `content_blocks_to_text`
- `tool_detail`

Use direct imports for `Arc`, `Mutex`, `TurnEvent`, `DesktopChatManager`, `DesktopChatToolSnapshot`, and `DesktopChatTurnSnapshot`.

- [x] **Step 3: Import extracted helpers**

In `chat.rs`, add:
```rust
pub(crate) mod turns;
use turns::{
    apply_desktop_turn_event,
    is_auto_compaction_failure_status,
    is_auto_compaction_success_status,
    prune_finished_turns,
    session_has_running_turn,
    snapshot_turn,
    update_turn,
};
```
Remove imports that are only used by `turns.rs`.

- [x] **Step 4: Verify desktop Rust split**

Run:
```bash
cargo fmt --all -- --check
cargo test -p kordi-desktop chat --no-default-features
cargo test -p kordi-desktop --no-default-features
pnpm maintainability:scan -- --min-lines 1000 --limit 12
git diff --check
```
Expected: formatting and desktop Rust tests pass; maintainability scan reports a smaller `app/desktop/src-tauri/src/chat.rs`.

- [x] **Step 5: Commit the extraction**

Run:
```bash
git add app/desktop/src-tauri/src/chat.rs app/desktop/src-tauri/src/chat/turns.rs docs/superpowers/plans/2026-05-03-desktop-chat-turn-state-split.md
git commit -m "Extract desktop chat turn state helpers"
```
