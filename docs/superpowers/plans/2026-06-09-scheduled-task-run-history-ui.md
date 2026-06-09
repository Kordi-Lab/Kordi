# Scheduled Task Run History UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add expandable scheduled task audit rows with running status, run history, response previews, and click-to-message navigation.

**Architecture:** Add a user-authenticated Cloud route to list runs for a scheduled task. Extend the Desktop scheduled task hook/client to fetch run history. Map scheduled tasks plus runs into existing `TaskActivityDashboardPanel` rows with subtasks/output preview rows that reuse the existing `onNavigateToResponse` message navigation.

**Tech Stack:** Rust/Axum/SQLx for Cloud server; React/TypeScript for Desktop; Node `tsx --test`; Cargo tests.

---

### Task 1: Backend scheduled run listing endpoint

**Files:**
- Modify: `bridges/cloud-server/src/scheduled_tasks/store.rs`
- Modify: `bridges/cloud-server/src/scheduled_tasks/routes.rs`
- Test: `bridges/cloud-server/tests/scheduled_task_tool_e2e.rs`

- [ ] **Step 1: Add failing tests**

Add source-level route/store checks and an integration store test that creates a task, run-now, and verifies `list_scheduled_task_runs` returns the latest run.

- [ ] **Step 2: Run backend test and verify failure**

Run: `cargo test -p kordi-cloud-server --test scheduled_task_tool_e2e scheduled_task -- --nocapture`

Expected: fails because `list_scheduled_task_runs` and route are missing.

- [ ] **Step 3: Implement store function**

Add `pub async fn list_scheduled_task_runs(pool, owner_account_id, task_id, limit)` returning `Vec<ScheduledTaskRunResponse>` ordered by `created_at DESC` and scoped by `owner_account_id`.

- [ ] **Step 4: Implement route**

Add `GET /v1/cloud/scheduled-tasks/:task_id/runs` using Cloud session auth and returning `{ runs }`.

- [ ] **Step 5: Verify**

Run: `cargo test -p kordi-cloud-server --test scheduled_task_tool_e2e -- --nocapture`

Expected: all scheduled task e2e tests pass.

### Task 2: Desktop scheduled task client/hook run history

**Files:**
- Modify: `app/desktop/src/features/cloud/scheduledTasksClient.ts`
- Modify: `app/desktop/src/features/cloud/useScheduledTasks.ts`
- Test: `app/desktop/tests/scheduledTasksClient.test.tsx`

- [ ] **Step 1: Add failing client test**

Test that `listScheduledTaskRuns(config, taskId)` requests `/v1/cloud/scheduled-tasks/:task_id/runs` and parses `{ runs }`.

- [ ] **Step 2: Run test and verify failure**

Run: `pnpm --dir app/desktop exec tsx --test tests/scheduledTasksClient.test.tsx`

Expected: fails because the function is missing.

- [ ] **Step 3: Implement client + hook state**

Add `listScheduledTaskRuns`. Extend `useScheduledTasks` to maintain `runsByTaskId`, fetch runs for listed tasks, expose it, and refresh on the same polling cadence.

- [ ] **Step 4: Verify**

Run: `pnpm --dir app/desktop exec tsx --test tests/scheduledTasksClient.test.tsx`

Expected: passes.

### Task 3: Expandable UI rows with run status and clickable previews

**Files:**
- Modify: `app/desktop/src/pages/ChatDetailPanel.tsx`
- Modify: `app/desktop/src/pages/TaskActivityDashboardPanel.tsx`
- Test: `app/desktop/tests/taskActivityDashboard.test.tsx`

- [ ] **Step 1: Add failing UI tests**

Test that a scheduled task with runs renders latest status, output preview text, and invokes `onNavigateToResponse` when the output preview is clicked.

- [ ] **Step 2: Run test and verify failure**

Run: `pnpm --dir app/desktop exec tsx --test tests/taskActivityDashboard.test.tsx`

Expected: fails because no run history rendering exists.

- [ ] **Step 3: Implement run mapping**

Pass `scheduledRunsByTaskId` from `ChatDetailPanel` into `TaskActivityDashboardPanel`. Convert runs to subtasks/output rows under the scheduled task row. For completed runs, match `resultMessage` against `messages` by cloud message id or canonical `sourceEventId`, extract `turn.assistantText` or text, and build a preview.

- [ ] **Step 4: Implement click navigation**

Make completed output preview rows clickable. On click call `onNavigateToResponse` with the local transcript/canonical message id when found.

- [ ] **Step 5: Verify UI tests**

Run: `pnpm --dir app/desktop exec tsx --test tests/taskActivityDashboard.test.tsx tests/scheduledTasksClient.test.tsx`

Expected: passes.

### Task 4: Final verification and preview restart

**Files:**
- No source changes unless tests reveal bugs.

- [ ] **Step 1: Run final targeted checks**

Run:
- `cargo test -p kordi-cloud-server --test scheduled_task_tool_e2e -- --nocapture`
- `pnpm --dir app/desktop exec tsx --test tests/taskActivityDashboard.test.tsx tests/scheduledTasksClient.test.tsx`
- `pnpm --dir app/desktop typecheck`

- [ ] **Step 2: Commit**

Commit with message: `feat: show scheduled task run history`

- [ ] **Step 3: Restart #558 preview**

Restart local preview at `http://127.0.0.1:1420/` using `VITE_KORDI_CLOUD_API_BASE="https://korde-product-cloud.35.188.85.31.sslip.io"` and unset `CARGO_TARGET_DIR`.
