# Kordi iOS cloud contract

The native iPhone client is a thin client of the canonical hosted service. Release builds use:

```text
https://kordi.ai
```

The iPhone does not run an LLM. Agent execution is restricted to the owner's connected macOS runtime or the hosted Cloud fallback runner. The phone writes requests, shows execution state, and reads synchronized results.

## Authentication and account state

The app supports email/password login, account creation, and Google/GitHub sign-in through `ASWebAuthenticationSession`.

```http
POST  /v1/cloud/auth/signup
POST  /v1/cloud/auth/login
GET   /v1/cloud/auth/oauth/:provider/start?redirectAfter=kordi://oauth/callback
GET   /v1/cloud/auth/me
PATCH /v1/cloud/auth/me
POST  /v1/cloud/auth/logout
```

The opaque session token is stored in iOS Keychain with `AfterFirstUnlockThisDeviceOnly` accessibility. It is not written to message caches or logs. OAuth accepts only the declared `kordi://oauth/callback` scheme, host, and path before decoding the Cloud result.

## Contacts, agents, and sessions

```http
GET  /v1/cloud/contacts
GET  /v1/cloud/contacts/requests
POST /v1/cloud/contacts/requests
POST /v1/cloud/contacts/requests/:id/accept
POST /v1/cloud/contacts/requests/:id/reject
GET  /v1/cloud/accounts/:kordiId/profile
GET  /v1/cloud/agents
GET  /v1/cloud/agents/shared?ownerAccountIds=...
GET  /v1/cloud/sessions/visibility
GET  /v1/cloud/sessions/:sessionId/forks
GET  /v1/cloud/sessions/:sessionId/pin
PUT  /v1/cloud/sessions/:sessionId/pin
```

The iOS projection mirrors the macOS product model:

- Contact contains direct-person chats, Kordi Support, and group spaces ordered by activity.
- Agent contains all accessible agent sessions ordered by activity, with forks nested under their source session.
- Kordi Support is one direct Contact conversation and is never projected as an Agent session.
- Hidden and deleted sessions are removed from the mobile catalog.

## Messages, attachments, and read state

```http
GET  /v1/cloud/messages?peerAccountId=...&limit=...
POST /v1/cloud/messages
POST /v1/cloud/messages/read
POST /v1/cloud/sessions/:sessionId/read
POST /v1/cloud/attachments/initiate
PUT  /v1/cloud/attachments/:attachmentId/upload
GET  /v1/cloud/attachments/:attachmentId/content
```

Outgoing messages carry a stable client message ID, client creation time, and canonical session ID. The app displays an optimistic local message and retains a failed state for explicit retry. Direct and group codecs preserve reply, forward, mention, attachment, and agent-target metadata used by macOS. Server delivery/read timestamps remain canonical.

Images are decoded as image attachments and rendered inline. Camera and photo-library input is converted to a cloud-safe image payload; the Files picker rejects images so the two attachment paths remain explicit.

## Agent execution and provider authentication

Agent requests use the existing direct/group message envelopes and claim execution through:

```http
POST /v1/cloud/agent-runs/claim
GET  /v1/cloud/agent-runs/request/:requestMessageId
GET  /v1/cloud/session-activity?sessionId=...
```

An `owner_online` claim means the connected owner's macOS runtime is responsible for execution. Otherwise the hosted runner may claim the request. The iPhone continues reading the synchronized result in both cases and never becomes an execution-capable presence.

Provider access and model routing use:

```http
GET    /v1/cloud/agent-provider-auth/snapshots/current
POST   /v1/cloud/agent-provider-auth/snapshots
DELETE /v1/cloud/agent-provider-auth/snapshots/:snapshotId
PATCH  /v1/cloud/agents/:agentId
```

Provider-auth payloads are encrypted by the server before storage and are scoped to the authenticated account. The iOS UI clears credential input after submission and does not persist the raw provider key in its local message stores. Never include credentials in logs, previews, screenshots, issues, or test fixtures.

## Sync and recovery

```http
GET /v1/cloud/sync?cursor=...
```

HTTP remains canonical. While foregrounded, iOS polls the ordered sync cursor and refreshes the affected account, contact, message, session, read-state, or agent-run projection. It intentionally does not open the presence-bearing desktop WebSocket because an iPhone must not make Cloud believe an owner's Mac runtime is online.

The on-device wire cache stores synchronized message/session data for fast restoration and offline reading. Pending writes and retry state remain visible until a canonical response resolves them. Signing out clears the account-scoped local state.

## Production boundary

- Production builds use `https://kordi.ai` over HTTPS.
- Use `--preview-data` for deterministic UI work without network writes.
- Use dedicated test accounts for bounded manual production checks.
- Never run destructive, load, fuzz, or throwaway multi-account tests against production.
- A test or self-hosted origin must be injected through a developer-only `CloudAPIClient` in tests; release UI does not expose an origin switch.
