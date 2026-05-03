# Durable Bridge Inbox and Parallel Per-Request Agent Jobs

Issue: #220

## Goal

Implement Option A end-to-end for Bridge agent asks:

1. Non-destructive server mailbox polling with explicit ack.
2. Desktop durable inbox acceptance before processing.
3. Durable local agent job records.
4. Scheduler with independent per-request jobs, including multiple jobs in the same chat when capacity allows.
5. UI/read-model behavior that does not treat raw `Processing...` placeholder text as proof of active work.

## Related work checked

- #218 / PR #219: single-flight polling and canonical refresh reduced local contention only; it did not add a durable inbox or scheduler.
- #221 / PR #222: fixed the stale `desktop-bridge-session-relay` no-mention/image subset; #211 still had `desktop-bridge-parent` processing artifacts.
- #211: false `Processing...` must be addressed by durable job state and suppression of stale/raw placeholder artifacts.
- #164: humans must keep chatting while one or more agent jobs run.

## Architecture

### Server mailbox ack cursor

Keep legacy `POST /v1/mailbox` for compatibility. Add:

- `POST /v1/mailbox/poll`
  - returns stable entries with `messageId`
  - does not delete entries on fetch
  - supports pagination/windowing
- `POST /v1/mailbox/ack`
  - deletes only entries for the authenticated recipient
  - is called only after the desktop has durably accepted the events locally

Crash rules:

- Crash before local insert: no ack, server redelivers.
- Crash after local insert and ack: local inbox/job state resumes work.

### Desktop durable inbox

`bridge_inbox_events` stores accepted Bridge events with:

- `id`
- optional `server_message_id`
- `host_id`
- `from_node_id`
- optional `request_id`
- `message_type`
- `chat_queue_key`
- `requesting_user_key`
- `payload_json`
- `status`
- timestamps

Dedupe keys:

- mailbox: `(host_id, server_message_id)`
- realtime/fallback without server id: `(host_id, from_node_id, message_type, request_id)` when `request_id` exists

### Desktop durable agent jobs

`bridge_agent_jobs` stores one local-agent job per accepted inbox event:

- `id`
- `inbox_event_id`
- optional `request_id`
- `requesting_user_key`
- `chat_queue_key`
- `status`: `queued`, `running`, `retry_wait`, `responded`, `processing_failed`, `cancelled`
- retry count / retry timestamp
- started/completed timestamps
- last error

### Scheduler rules

- Per requesting user active limit: 8 jobs.
- Limits are independent per user; one user at 8 active jobs must not block another user.
- Same-chat independent requests may run concurrently when capacity allows.
- Human messages are never blocked by job execution.
- Transient runtime/start failures become retryable jobs, not immediate final failed turns.
- Responses attach by `requestId/jobId` through existing Bridge request metadata and per-direction message upsert keys.

### Realtime/mailbox parity

Realtime local-agent asks and mailbox local-agent asks both create durable inbox/job rows, then start work via the shared scheduler.

### UI/read-model state

The transcript must not render raw stale Bridge placeholder rows as real active work:

- Current work may still create a processing placeholder after a durable job exists so group participants see an in-flight turn.
- Read-model suppression hides stale `desktop-bridge-session-relay` placeholders and raw `desktop-bridge-parent` `Processing...` artifacts, including terminal/cancelled rows whose visible text is still `processing...`.
- Longer-term UI can expose job rows directly, but this PR prevents false positives from raw placeholder artifacts.

## Implemented slices

1. Server acked polling routes and client helpers.
2. Desktop inbox/job schema, idempotent inserts, and storage tests.
3. Pure scheduler rules and tests.
4. Mailbox ingestion refactor: poll → persist → ack → schedule.
5. Realtime local-agent asks routed through the same durable job path.
6. Read-model suppression for raw Bridge parent processing placeholders.

## Verification targets

- `cargo test --manifest-path bridges/cli/Cargo.toml mailbox`
- `cargo test -p kordi-desktop --no-default-features bridge::agent_jobs`
- `cargo test -p kordi-desktop --no-default-features bridge::storage::tests::inbox_event`
- `pnpm --dir app/desktop test:unit -- chatRouting.test.tsx`
- Full desktop typecheck/lint/unit/build before PR completion.
