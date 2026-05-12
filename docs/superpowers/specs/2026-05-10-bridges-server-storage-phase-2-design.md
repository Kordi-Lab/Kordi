# Bridges Server Storage Phase 2 Design

Implements Phase 2 of [#332](https://github.com/Kordi-AI/Kordi/issues/332): idempotent client send keys plus the move from full-copy mailbox rows to a message-log + recipient-delivery model. Wire-compatible during migration.

Phase 1 (#332 PRs 1–6) landed schema-version migrations, hot-path indexes with `EXPLAIN` pinning, the single-writer `DbRunner`, chunked ack, criterion baselines, and mailbox retention GC. This spec builds on that foundation.

## What changes for clients

Today: `POST /v1/relay` and `POST /v1/broadcast` create one `server_mailbox` row per recipient, no idempotency. Retries duplicate.

After Phase 2:
- Both routes accept an optional `clientMessageId`. Repeating the same `(target, clientMessageId)` is a no-op and returns the original `messageId`.
- Internally, the mailbox is split into `server_messages` (one row per send, holds metadata + payload) and `server_message_recipients` (one tiny row per recipient, holds delivery + read state). Broadcast writes 1 message row + N recipient rows instead of N full-copy rows — a 3–5× reduction in write amplification per the projections in `docs/perf/bridges-baseline-2026-05-10.md`.
- `/v1/mailbox/poll` and `/v1/mailbox/ack` keep their wire shape but read from the new tables. Existing clients work unchanged.

## Sequenced PRs

### PR 2.1 — Idempotent send keys (this PR)

Smallest piece, isolated, lands first.

- Schema migration 4: add `client_message_id TEXT` column to `server_mailbox` plus a partial unique index `(target_node_id, client_message_id) WHERE client_message_id IS NOT NULL`. Older rows have `NULL` and stay non-unique.
- `RelayReq` and `BroadcastReq` accept an optional `clientMessageId` per recipient.
- `enqueue_mailbox_entry` now uses `INSERT … ON CONFLICT(target_node_id, client_message_id) DO UPDATE SET message_id = message_id RETURNING message_id` so a conflict returns the existing `message_id` instead of failing — idempotent retries return the same id.
- `RelayResp` gains `messageId` so the client can correlate.
- Tests: same `clientMessageId` twice produces one row + same response; different keys produce two rows; no key behaves as today.

What does **not** land: the message/recipient table split (PR 2.2), the dual-write (PR 2.3), or the read-path migration (PR 2.4).

### PR 2.2 — `server_messages` + `server_message_recipients` schema

Migration 5 introduces:

```sql
CREATE TABLE server_messages (
    message_id        TEXT PRIMARY KEY,
    sender_node_id    TEXT NOT NULL,
    project_id        TEXT,
    payload_blob      TEXT,         -- payload for non-fanout sends; NULL when per-recipient ciphertext is used
    client_message_id TEXT,
    created_at        TEXT NOT NULL
);
CREATE INDEX idx_server_messages_sender_created ON server_messages(sender_node_id, created_at);
CREATE UNIQUE INDEX idx_server_messages_client_msg
    ON server_messages(sender_node_id, client_message_id) WHERE client_message_id IS NOT NULL;

CREATE TABLE server_message_recipients (
    message_id        TEXT NOT NULL,
    recipient_node_id TEXT NOT NULL,
    ciphertext_blob   TEXT,         -- per-recipient ciphertext when E2EE varies per peer; NULL when payload_blob carries the body
    delivered_at      TEXT,
    read_at           TEXT,
    PRIMARY KEY (message_id, recipient_node_id),
    FOREIGN KEY (message_id) REFERENCES server_messages(message_id) ON DELETE CASCADE
);
CREATE INDEX idx_server_message_recipients_recipient
    ON server_message_recipients(recipient_node_id, delivered_at);
```

DB-layer write helpers land too (no HTTP route migration yet): `insert_message_with_recipients`, `lookup_message_by_client_id`. No production code calls them yet — that comes in PR 2.3.

### PR 2.3 — Dual-write enqueue

Both `/v1/relay` and `/v1/broadcast` start writing to the new tables AND keep writing to `server_mailbox`. Reads still come from `server_mailbox`. This lets the migration be reverted without data loss.

### PR 2.4 — Migrate read paths

`/v1/mailbox/poll` and `/v1/mailbox/ack` switch to the new tables. Poll reads from `server_message_recipients` joined to `server_messages`; ack updates `server_message_recipients.delivered_at` instead of deleting from `server_mailbox`. Wire shape unchanged.

A backfill migration copies existing `server_mailbox` rows into the new tables before flipping reads — old rows still drain through the new path during the transition.

### PR 2.5 — Stop writing the legacy table

Remove the dual-write. `server_mailbox` becomes legacy: rows are GC'd after a grace period. The retention task from Phase 1 PR 6 already handles this — the existing 30-day retention applies to the legacy table during the transition.

## Invariants this design preserves

1. **Wire compatibility.** Every PR keeps existing `/v1/relay`, `/v1/broadcast`, `/v1/mailbox/poll`, `/v1/mailbox/ack` request/response shapes. New optional fields only.
2. **No data loss during migration.** Dual-write before flipping reads; legacy table kept until backfill is complete.
3. **Reversible per PR.** Each PR can be reverted by dropping its commit. Schema additions are additive; the migration framework guarantees idempotent re-application.
4. **No new client requirements.** Clients that don't send `clientMessageId` keep working with at-least-once semantics.

## Verification gate (per PR)

- `cargo test -p bridges` green.
- For PR 2.1: a regression test that asserts duplicate-send is idempotent, plus a test that asserts non-keyed sends still produce separate rows.
- For PR 2.4: a benchmark run comparing broadcast fanout before/after, recorded in `docs/perf/bridges-baseline-<date>.md`. Expected drop in write amplification is 3–5×.
