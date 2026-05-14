# Cloud Diff Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add durable cursor-based Cloud diff sync so desktop can render local chat backup first and fetch only Cloud changes since the last applied cursor.

**Architecture:** Add an account-scoped `cloud_sync_events` append-only table. Cloud writes append ordered events for each affected account. Desktop stores a per-account cursor, pulls `/v1/cloud/sync`, applies events idempotently to its local message cache, then advances the cursor.

**Tech Stack:** Rust/Axum/sqlx/Postgres Cloud server; TypeScript React desktop client; Node test runner; Cargo tests.

---

## File structure

- Create `bridges/cloud-server/migrations/0009_cloud_sync_events.sql`: account-scoped monotonic sync event table and index.
- Modify `bridges/cloud-server/src/pg/pool.rs`: embed migration 9.
- Modify `bridges/cloud-server/src/auth/routes.rs`: sync structs, `/v1/cloud/sync`, event append helper, message/read event writers.
- Modify `bridges/cloud-server/src/events/mod.rs`: include message IDs for read notifications if needed later; WS remains a hint.
- Modify `bridges/cloud-server/tests/cloud_auth_e2e.rs`: backend sync endpoint/event tests.
- Modify `app/desktop/src/features/cloud/authClient.ts`: sync event types and `syncCloudEvents` client method.
- Create `app/desktop/src/features/cloud/cloudDiffSync.ts`: cursor storage, event application, page pull loop.
- Modify `app/desktop/src/features/cloud/useCloudBridgeState.ts`: use diff sync on startup and WebSocket hints, with existing full peer reload fallback.
- Create/modify `app/desktop/tests/cloudDiffSync.test.tsx`: client cursor/idempotency/event application tests.

## Tasks

### Task 1: Backend sync event storage and API

- [ ] Write failing e2e tests in `bridges/cloud-server/tests/cloud_auth_e2e.rs`:
  - `cloud_sync_returns_message_events_after_cursor`
  - `cloud_sync_paginates_and_advances_cursor`
  - `cloud_sync_returns_read_receipt_events`
- [ ] Run: `cargo test -p kordi-cloud-server --test cloud_auth_e2e cloud_sync_ -- --nocapture`
  - Expected before implementation with DB: route returns 404 or missing events.
- [ ] Add migration 9 and embed it in `pg/pool.rs`.
- [ ] Add `GET /v1/cloud/sync?cursor=&limit=` returning `{ cursor, hasMore, events }`.
- [ ] Append `message.upsert` events for sender and recipient when messages are sent.
- [ ] Append `message.read` events for the sender when read state changes.
- [ ] Run backend sync tests.

### Task 2: Desktop diff-sync model

- [ ] Write failing tests in `app/desktop/tests/cloudDiffSync.test.tsx` for:
  - applying `message.upsert` idempotently by `messageId`
  - applying `message.read` to cached messages
  - cursor advances only after events apply
  - invalid cursor response requests fallback
- [ ] Run: `pnpm --dir app/desktop test:unit -- cloudDiffSync.test.tsx`
  - Expected before implementation: module/function missing.
- [ ] Add `CloudSyncEvent`, `CloudSyncResponse`, and `syncCloudEvents` to `authClient.ts`.
- [ ] Add `cloudDiffSync.ts` with storage helpers and event application helpers.
- [ ] Run desktop diff-sync tests.

### Task 3: Desktop startup/WebSocket integration

- [ ] Write/extend tests in `app/desktop/tests/cloudBridgeState.test.tsx` for diff sync preserving existing full reload fallback.
- [ ] Wire `useCloudBridgeState` startup to load local cache, call diff sync, and fallback to full sync on unsupported/invalid cursor.
- [ ] Change WebSocket message/read handlers to call diff sync instead of forcing full per-peer reload; keep direct WS merge as optimistic hint only if needed.
- [ ] Run `pnpm --dir app/desktop test:unit -- cloudBridgeState.test.tsx cloudDiffSync.test.tsx cloudInitialSync.test.tsx`.

### Task 4: Verification and commit

- [ ] Run `pnpm --dir app/desktop typecheck`.
- [ ] Run focused desktop unit tests.
- [ ] Run `cargo test -p kordi-cloud-server oauth_avatar_policy_tests --lib` plus sync e2e tests when `DATABASE_URL` exists.
- [ ] Run `git diff --check`.
- [ ] Commit with message `feat(cloud): add cursor-based diff sync`.
