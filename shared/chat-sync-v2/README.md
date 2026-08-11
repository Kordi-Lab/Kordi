# Kordi reliable chat sync v2

This directory is the transport-neutral contract for canonical Kordi chat.
The server implementation lives in `bridges/cloud-server/src/chat_sync`.

Protocol rules:

- PostgreSQL is the canonical server state.
- A client renders only state committed to its local database.
- Every durable mutation has a client-generated UUIDv7 operation ID.
- Conversation timeline order uses `conversation_sequence`.
- Cross-device recovery uses a contiguous per-user `stream_seq`.
- HTTP and WebSocket delivery are at least once; writes and event application
  are idempotent.
- Shared conversation titles and private per-user titles are versioned durable
  state. They do not consume timeline sequence positions.
- Fork lineage is part of the durable conversation snapshot. Bootstrap and
  replay therefore reconstruct the same session tree without a legacy sync
  event.
- Group membership snapshots are authoritative. Removed accounts receive a
  durable tombstone and receive no later message events for that conversation.
- A conversation snapshot contains public member state, including the current
  public display name and avatar used to render members who are not direct
  contacts, plus a `preferences`
  object projected only for the requesting account. Another member's private
  title and preference version are never serialized into bootstrap, HTTP, or
  durable fanout payloads.
- Unknown critical events stop sync. Unknown non-critical events may be
  ignored while advancing the cursor.

The `/v2/chat` surface is the exclusive product chat transport and remains fail-closed unless
`KORDI_CHAT_SYNC_V2_ENABLED` is explicitly enabled and
`KORDI_CHAT_SYNC_CURSOR_SECRET` contains at least 32 bytes.

Realtime clients exchange the bearer session for a single-use ticket at
`POST /v2/chat/realtime/ticket`, then connect to
`wss://<host>/v2/chat/realtime?ticket=...`. Tickets expire after 30 seconds,
are stored only as hashes, and are bound to the authenticated device. Browser
requests also require an exact match in
`KORDI_CHAT_REALTIME_ALLOWED_ORIGINS`; the accepted Origin is bound into the
ticket and checked again during the WebSocket upgrade. The ticket response
also returns the non-secret bound `device_id` required by the first `connect`
frame.

Each WebSocket event includes both its contiguous `stream_seq` and the opaque
cursor representing that event. A client commits the entity update, sequence,
and cursor in the same local transaction. WebSocket delivery reads the durable
PostgreSQL stream and periodically polls it, so notifications are only latency
hints and never a recovery dependency.

Migration `0048_backfill_reliable_chat_sync_v2.sql` performs the one-time v1
history cutover. It collapses historical per-recipient group fanout into one
canonical timeline item, preserves attachment and read state, records every
legacy-to-canonical message mapping, and advances the affected users' sync
retention floor. A device holding a cursor from before the backfill therefore
receives `SYNC_CURSOR_EXPIRED` and performs a consistent v2 bootstrap instead
of silently keeping an incomplete local projection.
