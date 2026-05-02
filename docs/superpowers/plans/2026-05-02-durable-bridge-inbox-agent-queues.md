# Durable Bridge Inbox and Agent Queues Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement #220's Telegram-style durable Bridge inbox, mailbox ack cursor, and per-chat/per-user agent job scheduling with 8 active jobs per user.

**Architecture:** Split the work into safe vertical slices. First add a non-breaking server ack-cursor mailbox API, then add local desktop inbox/job persistence, then add a pure scheduler, then wire mailbox and realtime ingestion through the same durable path. Keep old `/v1/mailbox` fetch-and-drain behavior until the new path is tested end-to-end.

**Tech Stack:** Rust, Axum, rusqlite/SQLite, Tauri commands, existing Bridge desktop storage, Node/Tsx unit tests for frontend state only where needed.

---

## File Structure

- `bridges/cli/src/serve/relay.rs`
  - Add non-destructive mailbox poll and explicit ack endpoints.
  - Keep existing `/v1/mailbox` behavior unchanged for compatibility.
- `bridges/cli/src/serve/mod.rs`
  - Add any server mailbox schema migration needed for stable ackable ordering, if message ids are insufficient.
- `bridges/cli/src/coord_client.rs`
  - Add client helpers for the new poll/ack API.
- `app/desktop/src-tauri/src/bridge/network.rs`
  - Add desktop wrappers for the new mailbox poll/ack API.
- `app/desktop/src-tauri/src/bridge/storage/conversations/schema.rs`
  - Add local `bridge_inbox_events` and `bridge_agent_jobs` tables.
- `app/desktop/src-tauri/src/bridge/storage/conversations/actions.rs`
  - Add idempotent insert/select/update helpers for inbox events and jobs.
- `app/desktop/src-tauri/src/bridge/storage/tests.rs`
  - Test inbox/job schema, dedupe, transitions, and resume behavior.
- `app/desktop/src-tauri/src/bridge/agent_jobs.rs` (new)
  - Pure scheduler rules: 8 active jobs per user, FIFO per chat, independent users/chats.
- `app/desktop/src-tauri/src/bridge/mailbox.rs`
  - Refactor mailbox fallback to fetch → persist → ack → schedule, without running agents inline.
- `app/desktop/src-tauri/src/bridge/realtime/local_agent.rs`
  - Route realtime local-agent asks through the same durable job acceptance/scheduler path.
- `app/desktop/src-tauri/src/bridge/mod.rs`
  - Wire new module exports and any startup/resume hook.
- `app/desktop/src/features/bridge/transcript.ts` and/or `app/desktop/src/features/canonical/readModel/messageMapping.ts`
  - Map queued/running/retry states if existing delivery states are insufficient.

---

## Slice 1: Server mailbox poll/ack API, compatibility preserved

**Files:**
- Modify: `bridges/cli/src/serve/relay.rs`
- Modify: `bridges/cli/src/coord_client.rs`
- Test: `bridges/cli/src/serve/relay.rs`

- [ ] **Step 1: Write failing server test: poll does not drain without ack**

Add a test in `bridges/cli/src/serve/relay.rs` near existing mailbox tests:

```rust
#[tokio::test]
async fn mailbox_poll_requires_ack_before_removal() {
    let state = test_state();
    seed_mailbox_entry(&state, "sender", "receiver", "blob-1");
    seed_mailbox_entry(&state, "sender", "receiver", "blob-2");

    let first = poll_mailbox_v2(
        State(state.clone()),
        Extension(AuthNode("receiver".to_string())),
        Json(MailboxPollReq { limit: Some(100), after: None }),
    )
    .await
    .expect("poll mailbox");
    assert_eq!(first.0.entries.len(), 2);

    let second = poll_mailbox_v2(
        State(state.clone()),
        Extension(AuthNode("receiver".to_string())),
        Json(MailboxPollReq { limit: Some(100), after: None }),
    )
    .await
    .expect("poll mailbox again");
    assert_eq!(second.0.entries.len(), 2, "poll must not destructively drain");

    let ack_ids = first.0.entries.iter().map(|entry| entry.message_id.clone()).collect();
    ack_mailbox_v2(
        State(state.clone()),
        Extension(AuthNode("receiver".to_string())),
        Json(MailboxAckReq { message_ids: ack_ids }),
    )
    .await
    .expect("ack mailbox");

    let after_ack = poll_mailbox_v2(
        State(state),
        Extension(AuthNode("receiver".to_string())),
        Json(MailboxPollReq { limit: Some(100), after: None }),
    )
    .await
    .expect("poll after ack");
    assert_eq!(after_ack.0.entries.len(), 0);
}
```

- [ ] **Step 2: Run failing server test**

Run:

```bash
cargo test --manifest-path bridges/cli/Cargo.toml mailbox_poll_requires_ack_before_removal
```

Expected: FAIL because `MailboxPollReq`, `poll_mailbox_v2`, and `ack_mailbox_v2` do not exist yet.

- [ ] **Step 3: Implement non-destructive poll/ack route**

In `bridges/cli/src/serve/relay.rs`:

- Add request/response structs:
  - `MailboxPollReq { limit: Option<usize>, after: Option<String> }`
  - `MailboxPollResp { entries: Vec<MailboxPollEntry> }`
  - `MailboxPollEntry { message_id, from, blob, project_id, timestamp }`
  - `MailboxAckReq { message_ids: Vec<String> }`
- Add routes:
  - `POST /v1/mailbox/poll`
  - `POST /v1/mailbox/ack`
- Implement `poll_mailbox_entries(conn, target_node_id, after, limit)` with stable order `created_at ASC, message_id ASC`.
- Implement `ack_mailbox_entries(conn, target_node_id, message_ids)` so a node can only ack its own mailbox entries.
- Leave existing `fetch_mailbox` and `/v1/mailbox` untouched.

- [ ] **Step 4: Add coord client helpers**

In `bridges/cli/src/coord_client.rs`, add:

```rust
pub async fn poll_mailbox(&self, after: Option<&str>, limit: Option<usize>) -> Result<MailboxPollResp, String>;
pub async fn ack_mailbox(&self, message_ids: &[String]) -> Result<(), String>;
```

Use existing `reqwest` client/bearer auth style.

- [ ] **Step 5: Verify slice 1**

Run:

```bash
cargo test --manifest-path bridges/cli/Cargo.toml mailbox_poll_requires_ack_before_removal
cargo test --manifest-path bridges/cli/Cargo.toml mailbox
```

Expected: mailbox tests pass; old fetch-and-drain tests still pass.

- [ ] **Step 6: Commit slice 1**

```bash
git add bridges/cli/src/serve/relay.rs bridges/cli/src/coord_client.rs
git commit -m "Add acked Bridge mailbox polling"
```

---

## Slice 2: Desktop durable inbox/job schema and storage helpers

**Files:**
- Modify: `app/desktop/src-tauri/src/bridge/storage/conversations/schema.rs`
- Modify: `app/desktop/src-tauri/src/bridge/storage/conversations/actions.rs`
- Test: `app/desktop/src-tauri/src/bridge/storage/tests.rs`

- [ ] **Step 1: Write failing storage tests**

Add tests covering:

```rust
#[test]
fn inbox_event_insert_is_idempotent_by_server_message_id() { /* insert same server message twice, assert one row */ }

#[test]
fn agent_job_tracks_queued_running_and_terminal_statuses() { /* create queued job, mark running, mark responded */ }

#[test]
fn queued_agent_jobs_resume_after_reopening_database() { /* create job, reopen db, select queued */ }
```

- [ ] **Step 2: Run failing storage tests**

Run:

```bash
bash scripts/prepare-tauri-sidecar-placeholders.sh
cargo test -p kordi-desktop --no-default-features inbox_event_insert_is_idempotent_by_server_message_id agent_job_tracks_queued_running_and_terminal_statuses queued_agent_jobs_resume_after_reopening_database
```

Expected: FAIL because tables/helpers do not exist.

- [ ] **Step 3: Add schema**

Add tables to `init_conversation_schema`:

- `bridge_inbox_events`
  - `id TEXT PRIMARY KEY`
  - `server_message_id TEXT`
  - `host_id TEXT NOT NULL`
  - `from_node_id TEXT NOT NULL`
  - `request_id TEXT`
  - `message_type TEXT NOT NULL`
  - `chat_queue_key TEXT NOT NULL`
  - `requesting_user_key TEXT NOT NULL`
  - `payload_json TEXT NOT NULL`
  - `status TEXT NOT NULL`
  - `received_at_ms INTEGER NOT NULL`
  - `acked_at_ms INTEGER`
  - unique index on `(host_id, server_message_id)` where `server_message_id IS NOT NULL`
- `bridge_agent_jobs`
  - `id TEXT PRIMARY KEY`
  - `inbox_event_id TEXT NOT NULL`
  - `request_id TEXT`
  - `requesting_user_key TEXT NOT NULL`
  - `chat_queue_key TEXT NOT NULL`
  - `status TEXT NOT NULL`
  - `retry_count INTEGER NOT NULL DEFAULT 0`
  - `next_retry_at_ms INTEGER`
  - `created_at_ms INTEGER NOT NULL`
  - `started_at_ms INTEGER`
  - `completed_at_ms INTEGER`
  - `last_error TEXT`

- [ ] **Step 4: Add storage helpers**

Add functions in `actions.rs` or a focused submodule:

```rust
insert_inbox_event_if_absent(...)
mark_inbox_event_acked(...)
create_agent_job_if_absent(...)
list_runnable_agent_jobs(...)
mark_agent_job_running(...)
mark_agent_job_retry_wait(...)
mark_agent_job_terminal(...)
```

- [ ] **Step 5: Verify slice 2**

Run:

```bash
bash scripts/prepare-tauri-sidecar-placeholders.sh
cargo test -p kordi-desktop --no-default-features inbox_event_insert_is_idempotent_by_server_message_id agent_job_tracks_queued_running_and_terminal_statuses queued_agent_jobs_resume_after_reopening_database
```

Expected: the new tests pass.

- [ ] **Step 6: Commit slice 2**

```bash
git add app/desktop/src-tauri/src/bridge/storage/conversations/schema.rs app/desktop/src-tauri/src/bridge/storage/conversations/actions.rs app/desktop/src-tauri/src/bridge/storage/tests.rs
git commit -m "Add durable Bridge inbox job storage"
```

---

## Slice 3: Pure scheduler rules

**Files:**
- Create: `app/desktop/src-tauri/src/bridge/agent_jobs.rs`
- Modify: `app/desktop/src-tauri/src/bridge/mod.rs`
- Test: `app/desktop/src-tauri/src/bridge/agent_jobs.rs`

- [ ] **Step 1: Write failing scheduler tests**

Tests:

```rust
#[test]
fn scheduler_starts_at_most_eight_jobs_per_user() { /* 10 queued same user, assert 8 selected */ }

#[test]
fn scheduler_keeps_user_limits_independent() { /* user A has 8 active, user B queued can start */ }

#[test]
fn scheduler_preserves_fifo_for_same_chat() { /* same chat has running earlier job, later not selected */ }

#[test]
fn scheduler_allows_different_chats_for_same_user_under_limit() { /* Chat A running, Chat B selected */ }
```

- [ ] **Step 2: Run failing scheduler tests**

Run:

```bash
cargo test -p kordi-desktop --no-default-features scheduler_
```

Expected: FAIL because module does not exist.

- [ ] **Step 3: Implement scheduler**

In `agent_jobs.rs`:

- Define `const MAX_ACTIVE_AGENT_JOBS_PER_USER: usize = 8;`
- Define simple structs for testable scheduling input/output.
- Implement `select_startable_jobs(queued, running, now_ms)`:
  - group running jobs by `requesting_user_key`
  - block queued jobs when user has 8 active
  - block queued jobs when same `chat_queue_key` has an earlier running/queued job
  - return stable FIFO order by created timestamp and id

- [ ] **Step 4: Verify slice 3**

Run:

```bash
cargo test -p kordi-desktop --no-default-features scheduler_
```

Expected: scheduler tests pass.

- [ ] **Step 5: Commit slice 3**

```bash
git add app/desktop/src-tauri/src/bridge/agent_jobs.rs app/desktop/src-tauri/src/bridge/mod.rs
git commit -m "Add Bridge agent job scheduler rules"
```

---

## Slice 4: Mailbox ingestion uses durable inbox and ack

**Files:**
- Modify: `app/desktop/src-tauri/src/bridge/network.rs`
- Modify: `app/desktop/src-tauri/src/bridge/mailbox.rs`
- Modify: `app/desktop/src-tauri/src/bridge/conversation_actions.rs` if helper reuse is needed
- Test: `app/desktop/src-tauri/src/bridge/mailbox.rs` and storage tests

- [ ] **Step 1: Write failing mailbox tests**

Tests:

```rust
#[tokio::test]
async fn mailbox_agent_ask_is_persisted_and_acked_before_job_runs() { /* fake poll response, assert inbox/job exists and ack called */ }

#[tokio::test]
async fn mailbox_duplicate_agent_ask_does_not_create_duplicate_job() { /* same server id twice */ }
```

- [ ] **Step 2: Run failing mailbox tests**

Run:

```bash
cargo test -p kordi-desktop --no-default-features mailbox_agent_ask_is_persisted_and_acked_before_job_runs mailbox_duplicate_agent_ask_does_not_create_duplicate_job
```

Expected: FAIL because mailbox path still runs inline.

- [ ] **Step 3: Add desktop network helpers**

In `network.rs`, add `poll_mailbox_v2` and `ack_mailbox_v2`, mirroring server structs.

- [ ] **Step 4: Refactor mailbox local-agent ask handling**

In `mailbox.rs`:

- Poll via new ackable endpoint when server supports it.
- For each event:
  - parse/decrypt
  - persist inbox event
  - append visible inbound message/queued placeholder
  - create job if ask targets local agent
  - ack server message after local commit
- Do not call `run_bridge_agent_prompt` inline from mailbox polling.
- Keep fallback to old `/v1/mailbox` until compatibility can be removed.

- [ ] **Step 5: Verify slice 4**

Run:

```bash
cargo test -p kordi-desktop --no-default-features mailbox_
cargo test -p kordi-desktop --no-default-features bridge::storage
```

Expected: mailbox/storage tests pass.

- [ ] **Step 6: Commit slice 4**

```bash
git add app/desktop/src-tauri/src/bridge/network.rs app/desktop/src-tauri/src/bridge/mailbox.rs app/desktop/src-tauri/src/bridge/storage app/desktop/src-tauri/src/bridge/conversation_actions.rs
git commit -m "Persist Bridge mailbox asks before scheduling"
```

---

## Slice 5: Job runner executes queued work and handles retryable start failures

**Files:**
- Modify: `app/desktop/src-tauri/src/bridge/agent_jobs.rs`
- Modify: `app/desktop/src-tauri/src/bridge/realtime/local_agent.rs` or create shared runner module
- Modify: `app/desktop/src-tauri/src/bridge/mod.rs`
- Test: `app/desktop/src-tauri/src/bridge/agent_jobs.rs`

- [ ] **Step 1: Write failing job-runner tests**

Tests:

```rust
#[tokio::test]
async fn retryable_start_failure_returns_job_to_queue_not_failed() { /* fake runner returns busy */ }

#[tokio::test]
async fn completed_job_starts_next_queued_same_user_job() { /* 8 active, one completes, next selected */ }
```

- [ ] **Step 2: Run failing tests**

Run:

```bash
cargo test -p kordi-desktop --no-default-features retryable_start_failure_returns_job_to_queue_not_failed completed_job_starts_next_queued_same_user_job
```

Expected: FAIL because runner does not exist.

- [ ] **Step 3: Implement runner loop**

- Add a scheduler tick function that selects startable jobs.
- Mark selected jobs `running` before spawning work.
- On temporary start-busy/start-unavailable errors, mark `queued` or `retry_wait` with `next_retry_at_ms`.
- On terminal provider failure after an actual run, preserve existing failed-turn semantics.
- On success, append/fanout the response and mark job `responded`.

- [ ] **Step 4: Verify slice 5**

Run:

```bash
cargo test -p kordi-desktop --no-default-features agent_job
```

Expected: job scheduler/runner tests pass.

- [ ] **Step 5: Commit slice 5**

```bash
git add app/desktop/src-tauri/src/bridge/agent_jobs.rs app/desktop/src-tauri/src/bridge/mod.rs app/desktop/src-tauri/src/bridge/realtime/local_agent.rs
git commit -m "Run queued Bridge agent jobs fairly"
```

---

## Slice 6: Realtime path parity

**Files:**
- Modify: `app/desktop/src-tauri/src/bridge/realtime/local_agent.rs`
- Test: `app/desktop/src-tauri/src/bridge/realtime/local_agent.rs`

- [ ] **Step 1: Write failing realtime parity test**

Test:

```rust
#[tokio::test]
async fn realtime_agent_ask_uses_same_inbox_job_path_as_mailbox() { /* handle event, assert inbox/job rows */ }
```

- [ ] **Step 2: Run failing test**

Run:

```bash
cargo test -p kordi-desktop --no-default-features realtime_agent_ask_uses_same_inbox_job_path_as_mailbox
```

Expected: FAIL because realtime still spawns direct local agent work.

- [ ] **Step 3: Route realtime asks through durable acceptance**

- Reuse the same inbox/job creation helper used by mailbox.
- Realtime can still send immediate processing acknowledgement after durable acceptance.
- Remove duplicate inline spawning path or make it call the shared scheduler.

- [ ] **Step 4: Verify slice 6**

Run:

```bash
cargo test -p kordi-desktop --no-default-features realtime_
cargo test -p kordi-desktop --no-default-features mailbox_
```

Expected: realtime and mailbox tests pass.

- [ ] **Step 5: Commit slice 6**

```bash
git add app/desktop/src-tauri/src/bridge/realtime/local_agent.rs app/desktop/src-tauri/src/bridge/agent_jobs.rs
git commit -m "Route realtime agent asks through durable jobs"
```

---

## Slice 7: UI/read-model queued state and integration verification

**Files:**
- Modify only if needed: `app/desktop/src/features/bridge/transcript.ts`
- Modify only if needed: `app/desktop/src/features/canonical/readModel/messageMapping.ts`
- Modify only if needed: `app/desktop/src/kordi-app/components/transcript.tsx`
- Test: targeted frontend tests under `app/desktop/tests`

- [ ] **Step 1: Inspect existing delivery-state rendering**

Check whether `processing`, `queued`, and `retry_wait` are already displayed safely. If not, add a test for visible queued status.

- [ ] **Step 2: Write failing UI test only if needed**

Example:

```tsx
test('queued bridge agent job renders as queued instead of failed', () => { /* map queued state */ });
```

- [ ] **Step 3: Implement minimal read-model/UI mapping**

Map queued/retry states to non-error pending visuals. Do not show final red failed state for capacity or retryable start failures.

- [ ] **Step 4: Verify slice 7**

Run:

```bash
pnpm --dir app/desktop test:unit
pnpm --dir app/desktop typecheck
pnpm --dir app/desktop lint
```

Expected: frontend tests/typecheck/lint pass.

- [ ] **Step 5: Commit slice 7**

```bash
git add app/desktop/src app/desktop/tests
git commit -m "Show queued Bridge agent jobs as pending"
```

---

## Final Verification

- [ ] Run frontend validation:

```bash
pnpm --dir app/desktop test:unit
pnpm --dir app/desktop typecheck
pnpm --dir app/desktop lint
pnpm --dir app/desktop build
```

- [ ] Run Rust validation:

```bash
cargo test --manifest-path bridges/cli/Cargo.toml mailbox
bash scripts/prepare-tauri-sidecar-placeholders.sh
cargo test -p kordi-desktop --no-default-features
cargo fmt --all -- --check
git diff --check
```

- [ ] Manual QA:
  - Launch two or three local QA users against dev Bridge.
  - Simulate >8 agent asks for one user and verify extra jobs queue.
  - Simulate another user asking while first user has 8 active jobs and verify second user can run.
  - Verify existing normal direct/group Bridge chat still works.

---

## Notes

- This branch is intentionally based on #219 (`fix/issue-218-bridge-poll-singleflight`) because #220 touches the same polling paths and should preserve the immediate contention fix.
- If #219 merges first, rebase this branch onto `origin/main` before opening the #220 PR.
- Avoid destructive DB cleanup. Schema changes must be additive and migration-safe.
