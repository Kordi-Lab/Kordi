# Cloud-Backed Agent Scheduled Task Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make agent-created scheduled work use Kordi Cloud scheduled-task API and show those jobs in the app panel.

**Architecture:** Add a first-class `schedule_task` built-in operator tool in `agent/crates/tools` that delegates to a runtime callback. In Desktop runtime, wire the callback to the Cloud scheduled-task HTTP API using the current Cloud API base and session token, then expose/list the same tasks in a real app panel.

**Tech Stack:** Rust agent tools/runtime (`kordi-tools`, `kordi-cli`, Tauri commands), Cloud HTTP API, React/TypeScript Desktop UI.

---

## File Structure

- `agent/crates/tools/src/schedule_task.rs` — new tool schema, runtime models, target-runtime guidance, and tests.
- `agent/crates/tools/src/types.rs` — add `ScheduleTaskRuntime` callback to `ToolContext`.
- `agent/crates/tools/src/registry.rs` and `agent/crates/tools/src/lib.rs` — register/export tool.
- `agent/crates/cli/src/scheduled_tasks_runtime.rs` — Desktop/CLI runtime adapter that POSTs to `/v1/cloud/scheduled-tasks`.
- `agent/crates/cli/src/desktop_runtime.rs`, `session_bootstrap.rs`, and tool-context test helpers — populate optional runtime.
- `app/desktop/src-tauri/src/chat.rs` / `cloud_session.rs` — attach Cloud token/API base to Desktop runtime sessions.
- `app/desktop/src/features/cloud/scheduledTasksClient.ts` — keep TS client as UI data source.
- `app/desktop/src/features/cloud/useScheduledTasks.ts` — React hook to list/refresh/pause/resume/run/delete tasks.
- `app/desktop/src/kordi-app/components/ScheduledTasksPanel.tsx` — improve labels like `Today 12:00` and statuses.
- `app/desktop/src/pages/SettingsPage.tsx` or right detail tasks surface — mount scheduled panel where users can see Cloud scheduled jobs.
- Tests in `agent/crates/tools`, `agent/crates/cli`, `app/desktop/tests`.

---

### Task 1: Add schedule_task tool contract

- [ ] Write failing Rust tests in `agent/crates/tools/src/schedule_task.rs` proving:
  - `schedule_task` deserializes `title`, `prompt`, `schedule`, `targetRuntime`, `toolPayload`.
  - local machine examples are documented in the description.
  - the tool delegates to `ctx.schedule_task` and returns the created task id/status.
- [ ] Run: `cargo test -p kordi-tools schedule_task -- --nocapture`; expect missing module/tool failures.
- [ ] Implement `ScheduleTaskTool`, request/response/runtime types, and add `schedule_task: Option<ScheduleTaskRuntime>` to `ToolContext`.
- [ ] Register/export `schedule_task` and update all `ToolContext` initializers with `schedule_task: None` or a runtime.
- [ ] Run the same tests; expect pass.

### Task 2: Wire Desktop runtime to Cloud API

- [ ] Write failing CLI runtime tests with a mock HTTP server/runtime function proving the runtime POSTs camelCase input to `/v1/cloud/scheduled-tasks` and includes Bearer token.
- [ ] Add `agent/crates/cli/src/scheduled_tasks_runtime.rs` with `build_scheduled_tasks_runtime(api_base, token)` using `reqwest`.
- [ ] Add `DesktopRuntimeSession::set_scheduled_tasks_cloud_runtime(api_base, token)` and call it from Tauri chat session creation/resume after loading the Cloud session.
- [ ] Run targeted CLI/Tauri compile tests; expect pass.

### Task 3: Prevent shell/at fallback in prompt guidance

- [ ] Add/adjust prompt-context tests so scheduling requests instruct agent to use `schedule_task`, not `bash`/`at`/cron, for user-visible scheduled work.
- [ ] Update available tool/system guidance only as needed; prefer the `schedule_task` tool description.
- [ ] Run targeted prompt/tool tests; expect pass.

### Task 4: Wire Cloud scheduled jobs into visible panel

- [ ] Write failing TS tests proving `ScheduledTasksPanel` renders `Check disk usage`, `Today 12:00`, and `Waiting for Desktop` for local-required waiting runs.
- [ ] Add `useScheduledTasks` hook to list and refresh Cloud tasks from `cloudSession.session.token`.
- [ ] Mount scheduled tasks in the existing Tasks detail surface or settings tools surface so the job appears in-app.
- [ ] Trigger a refresh after a chat turn completes so newly created scheduled jobs appear without app restart.
- [ ] Run scheduled panel/client tests and typecheck; expect pass.

### Task 5: End-to-end verification and deployment

- [ ] Run:
  - `cargo test -p kordi-tools schedule_task -- --nocapture`
  - `cargo test -p kordi-cli scheduled_tasks_runtime -- --nocapture`
  - `pnpm --dir app/desktop exec tsx --test tests/scheduledTasksClient.test.tsx tests/scheduledTasksPanel.test.tsx`
  - `pnpm --dir app/desktop typecheck`
- [ ] Commit implementation.
- [ ] Push PR #559.
- [ ] Redeploy to `takotako` and smoke test: ask agent to schedule disk usage, confirm Cloud API task exists and panel shows the job.

---

## Self-Review

- Spec coverage: covers agent tool creation, local-vs-cloud runtime decision guidance, visible panel, and verification.
- Placeholder scan: no TBD/TODO placeholders.
- Type consistency: uses existing API names: `schedule`, `targetRuntime`, `localRequired`, `/v1/cloud/scheduled-tasks`.
