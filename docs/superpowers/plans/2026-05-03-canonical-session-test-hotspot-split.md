# Canonical Session Test Hotspot Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Reduce the largest maintainability hotspot, `app/desktop/src-tauri/src/canonical_sessions/tests.rs`, by moving domain-specific tests into small sibling modules without changing behavior.

**Architecture:** Keep `canonical_sessions.rs` loading `tests.rs` exactly as it does today. Keep common in-memory database helpers in `tests.rs`, and add child test modules under `app/desktop/src-tauri/src/canonical_sessions/tests/` that import `super::*` so private canonical session helpers remain accessible.

**Tech Stack:** Rust unit tests, `cargo fmt`, `cargo test -p kordi-desktop --no-default-features`.

---

### Task 1: Split desktop/direct/group canonical session tests into child modules

**Files:**
- Modify: `app/desktop/src-tauri/src/canonical_sessions/tests.rs`
- Create: `app/desktop/src-tauri/src/canonical_sessions/tests/desktop_sync.rs`
- Create: `app/desktop/src-tauri/src/canonical_sessions/tests/direct_message_sync.rs`
- Create: `app/desktop/src-tauri/src/canonical_sessions/tests/group_message_sync.rs`
- Create: `app/desktop/src-tauri/src/canonical_sessions/tests/group_agent_requests.rs`
- Create: `app/desktop/src-tauri/src/canonical_sessions/tests/group_agent_responses.rs`

- [x] **Step 1: Capture baseline canonical session test list**

Run:
```bash
cd /Users/shuyang/kordi-worktrees/issue-235-maintainability-boundaries
rg '^fn ' app/desktop/src-tauri/src/canonical_sessions/tests.rs -n
```
Expected: the file contains the existing canonical session test names, including `desktop_sync_enriches_similar_bridge_agent_message_with_local_runtime_details`, `inbound_group_session_message_reconstructs_group_parent_and_members`, and `inbound_group_local_agent_response_join_uses_response_sender_agent`.

- [x] **Step 2: Add child module declarations**

Add these declarations near the top of `app/desktop/src-tauri/src/canonical_sessions/tests.rs`, after common helpers:
```rust
mod desktop_sync;
mod direct_message_sync;
mod group_agent_requests;
mod group_agent_responses;
mod group_message_sync;
```

- [x] **Step 3: Move desktop sync tests**

Create `app/desktop/src-tauri/src/canonical_sessions/tests/desktop_sync.rs` with:
```rust
use super::*;
```
Then move these unchanged tests from `tests.rs` into it:
- `direct_agent_outreach_sync_keeps_owner_out_of_private_parent_participants`
- `outreach_context_snapshot_is_session_scoped`
- `active_desktop_chat_without_explicit_project_membership_stays_self_agent`
- `blank_desktop_drafts_do_not_sync_into_canonical_sessions`
- `shared_bridge_local_agent_runtime_prompt_is_not_synced_as_extra_user_message`
- `desktop_sync_enriches_similar_bridge_agent_message_with_local_runtime_details`
- `desktop_sync_enriches_bridge_agent_message_when_relay_collapses_whitespace`
- `desktop_sync_replaces_processing_bridge_agent_placeholder_with_local_runtime_details`
- `desktop_sync_does_not_reclassify_bridge_sessions`
- `bridge_human_display_name_strips_scoped_kordi_label`
- `snapshot_you_sender_uses_remote_human_name_for_receiver`

- [x] **Step 4: Move direct/session message tests**

Create `app/desktop/src-tauri/src/canonical_sessions/tests/direct_message_sync.rs` with:
```rust
use std::collections::HashSet;

use super::*;
```
Then move these unchanged tests from `tests.rs` into it:
- `source_event_dedupes_messages`
- `source_event_reconcile_updates_streamed_agent_content`
- `message_scoped_outreach_groups_include_same_request_response_without_message_outreach`
- `direct_person_bridge_conversation_uses_first_message_title_without_renaming_participants`
- `inbound_session_message_creates_direct_person_parent_with_first_message_title`
- `attachment_only_session_message_syncs_into_parent_session`
- `synced_user_message_reconciles_optimistic_ui_message`

- [x] **Step 5: Move group message tests**

Create `app/desktop/src-tauri/src/canonical_sessions/tests/group_message_sync.rs` with:
```rust
use super::*;
```
Then move these unchanged tests from `tests.rs` into it:
- `inbound_group_session_message_reconstructs_group_parent_and_members`
- `outbound_group_session_message_sent_ack_reconciles_as_delivered_with_attachments`
- `group_admin_count_uses_group_metadata_not_local_self_role`
- `inbound_group_session_invite_reconstructs_group_parent_without_visible_message`
- `inbound_group_session_update_renames_group_without_visible_message`

- [x] **Step 6: Move group agent request tests**

Create `app/desktop/src-tauri/src/canonical_sessions/tests/group_agent_requests.rs` with:
```rust
use super::*;
```
Then move these unchanged tests from `tests.rs` into it:
- `group_agent_response_without_top_level_context_rejoins_session_message_group`
- `group_session_fanout_reconciles_duplicate_parent_message_copies`
- `group_bridge_agent_session_message_keeps_request_and_response`
- `inbound_group_bridge_agent_request_emits_join_even_when_agent_already_participates`

- [x] **Step 7: Move group agent response tests**

Create `app/desktop/src-tauri/src/canonical_sessions/tests/group_agent_responses.rs` with:
```rust
use super::*;
```
Then move these unchanged tests from `tests.rs` into it:
- `group_local_agent_response_fanout_reconciles_duplicate_response_copies`
- `inbound_group_agent_response_fanout_join_uses_remote_agent_label`
- `inbound_group_local_agent_response_join_uses_response_sender_agent`

- [x] **Step 8: Verify Rust test split**

Run:
```bash
cargo fmt --all -- --check
cargo test -p kordi-desktop canonical_sessions --no-default-features
pnpm maintainability:scan -- --min-lines 1000 --limit 12
git diff --check
```
Expected: formatting passes, canonical session tests pass, scan no longer lists `app/desktop/src-tauri/src/canonical_sessions/tests.rs`, and the split child modules stay below 1000 lines.

- [x] **Step 9: Commit the test split**

Run:
```bash
git add app/desktop/src-tauri/src/canonical_sessions/tests.rs app/desktop/src-tauri/src/canonical_sessions/tests docs/superpowers/plans/2026-05-03-canonical-session-test-hotspot-split.md
git commit -m "Split canonical session test modules"
```
