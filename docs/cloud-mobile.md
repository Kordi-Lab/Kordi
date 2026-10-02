# Kordi iOS cloud contract

The native iPhone client is a thin client of the canonical hosted service. Release builds use:

```text
https://kordi.ai
```

That release origin does not authorize product-server development or validation. Select the path in [Development environment isolation](development-environments.md) before any backend-connected test. Operator work that will affect or restart the product server must follow the [required environment preflight](hosted-cloud-developer-guide.md#required-preflight-before-preview-or-debug), run on the corresponding product-server machine, and validate the deployed product through `https://kordi.ai`.

The iPhone does not run an LLM. Agent execution is restricted to the owner's connected macOS runtime or the hosted Cloud fallback runner. The phone writes requests, shows execution state, and reads synchronized results.

## Authentication, contacts, agents, and ancillary state

Authentication, identity, contacts, attachments, invitations, presence, agent operations, session activity, forks, and pins use independently versioned `/v1/cloud/...` resource APIs. These paths do not carry canonical chat state.

The opaque session token is stored in iOS Keychain with `AfterFirstUnlockThisDeviceOnly` accessibility. It is not written to message caches or logs. The production identity accepts only `kordi://oauth/callback`; the isolated Beta identity accepts only `kordi-beta://oauth/callback`. Each build validates the exact scheme, host, and path before decoding the Cloud result.

The iOS projection mirrors the macOS product model:

- Contact contains direct-person chats, Kordi Support, and group spaces ordered by activity.
- Agent contains all accessible agent sessions ordered by activity, with forks nested under their source session.
- Kordi Support is one direct Contact conversation and is never projected as an Agent session.
- Hidden and deleted sessions are removed from the mobile catalog.

## Canonical chat

All conversation, message, delivery, read, title, membership, and recovery state uses the canonical `/v2/chat` protocol:

```http
GET  /v2/chat/conversations
POST /v2/chat/conversations
GET  /v2/chat/conversations/:conversationId/messages
POST /v2/chat/conversations/:conversationId/messages
PUT  /v2/chat/conversations/:conversationId/messages/:messageId/reactions
DELETE /v2/chat/conversations/:conversationId/messages/:messageId/reactions
PUT  /v2/chat/conversations/:conversationId/delivered
PUT  /v2/chat/conversations/:conversationId/read
PUT  /v2/chat/conversations/:conversationId/preferences
GET  /v2/chat/sync/bootstrap
GET  /v2/chat/sync?cursor=...
POST /v2/chat/realtime/ticket
WS   /v2/chat/realtime
```

PostgreSQL is the server source of truth. Every accepted message has one canonical UUID, a conversation sequence, a stable client-generated idempotency UUID, and durable per-user sync events committed in the same transaction. Retrying the same operation returns the original result. Read and delivery cursors are monotonic. Shared titles and account-specific titles are versioned conversation preferences and travel through the same durable stream.

The UI reads the account-scoped local database. A sync batch applies entity snapshots and advances its opaque cursor in one local transaction. Unknown critical events stop the client before the cursor advances. Cursor expiry requires a new consistent bootstrap.

Outgoing messages appear optimistically and retain their original client message ID across timeouts and retries. A server acknowledgement or replay reconciles the pending row with its canonical message ID and sequence. Push and WebSocket frames are wake-up or low-latency delivery paths; `/v2/chat/sync` remains the recovery source.

The iPhone currently uses ordered HTTP cursor recovery while foregrounded instead of opening the desktop presence WebSocket. It must not make the service believe the owner's Mac execution runtime is online.

## Contact consent, blocks, reports, and leaving groups

The iPhone uses the routes described in [Contacts and blocking](trust-and-safety/contacts-and-blocking.md) and [Abuse reports](trust-and-safety/abuse-reports.md):

```http
DELETE /v1/cloud/contacts/:peerAccountId
POST   /v1/cloud/contacts/requests/:requestId/withdraw
GET    /v1/cloud/blocks
PUT    /v1/cloud/blocks/:accountId
DELETE /v1/cloud/blocks/:accountId
POST   /v1/cloud/reports
POST   /v2/chat/conversations/:conversationId/leave
```

- Feature detection uses only `GET /v1/cloud/blocks`. An empty 404 there means the server has none of these actions yet, and the app hides remove, withdraw, block, report, and leave. A 404 with an error code from any other route is an ordinary missing record.
- A message report names one message by its canonical id (`reactionTargetMessageId`, else the message id) and its conversation; the server copies the evidence and finds the sender. An account report may carry the contact request it came from. The app keeps one `clientReportId` while the same report is retried.
- Leaving a group posts a `group-update` to each channel that lists everyone except the leaver and carries `memberLeaves` (a leaving owner lists the successor as `admin`), then calls the leave route once on the group's main conversation with the successor as a hint, then removes the group locally. A connection failure before the server leave stops it without local changes.
- Group participants from older envelopes are dropped when the canonical membership says they left or were removed, so later updates never list them again.
- Direct chats with someone who is no longer a contact stay readable; a refused send shows the server's message.

## Attachments and agent execution

Attachment upload and download stay on the authenticated resource API, while attachment relationships are stored on canonical chat messages. Agent requests claim execution through the Cloud agent-run APIs. Owner-online claims execute on the connected macOS runtime; otherwise the hosted fallback runner can execute. Every result is persisted as a canonical assistant message before it is considered delivered.

Provider-auth payloads are encrypted by the server and scoped to the authenticated account. The iOS UI clears credential input after submission and never persists raw provider credentials in its local message database. Never include credentials in logs, previews, screenshots, issues, or test fixtures.

## Production boundary

- Production builds use `https://kordi.ai` over HTTPS.
- Beta builds use only `http://127.0.0.1:17081`, have a separate bundle identifier and secure-storage service, and are visually distinguished by a gray icon.
- Use `--preview-data` for deterministic UI work without network writes.
- Use dedicated test accounts for bounded manual production checks.
- Never run destructive, load, fuzz, or throwaway multi-account tests against production.
- A test or self-hosted origin must be injected through a developer-only `CloudAPIClient`; release UI does not expose an origin switch.
