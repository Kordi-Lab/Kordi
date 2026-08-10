# Cloud message lifecycle

## Decision

Kordi uses one authoritative directed-delivery store (`cloud_messages`) and
one durable account-scoped event log (`cloud_sync_events`). Realtime transport
is only a wakeup mechanism; it is never a second source of message content or
ordering.

`server_messages` / `server_message_recipients` is an unused future fanout
foundation, not a second live source of truth. Do not dual-write to it without
an explicit backfill, dual-read verification, and cutover plan.

```text
producer operation
  -> stable clientMessageId
  -> POST /v1/cloud/messages
  -> one Postgres transaction
       cloud_messages
       cloud_message_attachments
       cloud_sync_events (one account projection event per observer)
  -> committed HTTP acknowledgement
  -> transactional-outbox worker
  -> JetStream sync.changed.<account> wakeup
  -> WebSocket frame
  -> GET /v1/cloud/sync?cursor=N
  -> idempotent projection by eventId/messageId
  -> cursor persisted after projection application
```

This is an at-least-once delivery design with exactly-once observable message
creation. Network delivery may repeat; applying a committed message does not.

## Lifecycle states

| State | Owner | Durable identity | Retry rule |
|---|---|---|---|
| `created` | producer | `clientMessageId` | Reuse the same ID for the same logical operation. |
| `submitted` | HTTP client | `clientMessageId` | A timeout is unknown outcome, so retry with the same ID. |
| `committed` | Postgres | `messageId` + sync `eventId` | Unique client ID returns the existing message. Changed parameters return `409 idempotency_conflict`. |
| `broadcast-pending` | `cloud_sync_events` outbox columns | `eventId` | Lease, publish, and retry with bounded backoff. |
| `broadcast` | JetStream | `Nats-Msg-Id: cloud-sync:<eventId>` | Broker deduplication is an optimization, not the correctness boundary. |
| `observed` | WebSocket client | `eventId` hint | A frame only schedules cursor synchronization. |
| `applied` | desktop projection/cache | `eventId` / `messageId` | Merge monotonically and persist the cursor only after applying the page. |
| `consumed` | read endpoint | peer/session read cursor | Commit the cursor, message `read_at`, and sender sync event together. |

## Invariants

1. A producer creates the operation ID before the first network attempt.
2. Every retry of that operation uses the same ID; a new intentional message
   gets a new ID even when its body and timestamp match an earlier message.
3. The server binds an idempotency ID to immutable command parameters:
   recipient, normalized body, session, and ordered attachment metadata.
4. For each message write, its row, attachment links, visibility changes, and
   account sync events commit atomically.
5. The server acknowledges the HTTP request only after that transaction commits.
6. Realtime payloads do not update the message projection directly. They cause
   a cursor read from the durable sync log.
7. Cache loss, WebSocket loss, duplicate NATS delivery, restart, and multi-device
   consumption cannot create another server message.
8. Content/time-window matching exists only for migration of historical clients
   that never emitted operation IDs. It is not part of the v2 write contract.
9. Server-side producers (agent completion/failure, group fanout, invitation
   acceptance, and contact auto-hello) obey the same operation-ID and
   transaction rules as HTTP producers.
10. A terminal agent-run retry returns its already-committed result. Concurrent
    terminal requests converge on one response message and one event per
    observer.

## Logical message versus directed delivery

A group send is one logical producer operation with a stable root ID. The
current compatibility schema materializes one `cloud_messages` row for each
recipient. Each row therefore uses a deterministic recipient-scoped operation
ID (`<root>:<recipientAccountId>`), while the group envelope carries the shared
logical message ID.

This preserves exactly-once creation today without pretending that the current
schema is already a one-row broadcast log. A future migration to one immutable
message plus N recipient delivery rows can retain the same producer IDs and
event contract; clients must not depend on the current pairwise row IDs being
the logical group-message identity.

## Broadcast and recovery

`cloud_sync_events` is also the transactional outbox. New rows start with
`realtime_published_at = NULL`. Workers claim ordered batches with
`FOR UPDATE SKIP LOCKED` leases. A successful JetStream acknowledgement marks
the row published; failures clear the lease and schedule bounded exponential
backoff. A worker crash after publish but before marking can duplicate a wakeup,
which is safe because the client consumes by the Postgres event cursor.

Deployments without NATS do not run the outbox worker. Cursor polling still
provides correctness and recovery; it only loses low-latency wakeups.

Legacy `message.arrived` and `message.read` subjects remain temporary wakeups
for older clients. Updated clients treat both those frames and `sync.changed`
as the same action: schedule one coordinated cursor sync. They never merge a
WebSocket payload directly into canonical state.

## Consumption and acknowledgement

Opening a peer or group session advances a monotonic durable read cursor. The
cursor update, affected `cloud_messages.read_at` rows, and `message.read` sync
event share one Postgres transaction. If it rolls back, none of the three is
observable. Retrying after a lost HTTP response is a no-op once no unread rows
remain, so it does not append another receipt event.

The cursor is the authoritative boundary for old history that falls outside a
bounded message snapshot. Per-row `read_at` remains the materialized projection
used for rendering and legacy clients.

## Failure matrix

| Failure | Recovery |
|---|---|
| HTTP response lost after commit | Producer retries the same operation ID and receives the existing message. |
| Process exits before DB commit | Transaction rolls back; producer retry creates the message once. |
| Process exits after DB commit but before NATS publish | Pending outbox row is claimed after restart. |
| Process exits after publish but before marking published | Wakeup may repeat; cursor/message application is idempotent. |
| WebSocket disconnects or misses a frame | Reconnect sync and the periodic cursor poll read the durable event log. |
| Two agent runners finish the same run concurrently | Run-row lock and terminal transaction select one response; the other returns the committed result. |
| Local cache or sync ledger is lost | Snapshot/cursor restoration rebuilds the projection without replaying writes. |

## Producer rules

- Direct UI sends use the optimistic message ID as `clientMessageId`.
- Durable group fanout derives one recipient-scoped operation ID from the
  canonical group message/control ID.
- Agent processing, terminal response, failure, and cancellation messages use
  IDs derived from the request/response identity and recipient.
- `CloudAuthClient.sendMessage` guarantees that no new write omits an operation
  ID. A caller that retries across method calls must still own and reuse its
  logical operation ID.
- History restoration must converge local projections from server snapshots. It
  must not replay history through the normal message creation endpoint.

## References

- NATS documents that Core NATS is at-most-once, while JetStream publishing is
  acknowledged and at-least-once: <https://docs.nats.io/nats-concepts/jetstream>
- JetStream publisher deduplication uses the client-defined `Nats-Msg-Id`
  header: <https://docs.nats.io/nats-concepts/jetstream/headers>
- PostgreSQL documents `SKIP LOCKED` as suitable for queue-like consumers:
  <https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE>
- AWS describes caller-provided request identifiers and rejecting the same key
  with different parameters as the safe retry contract:
  <https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/>
