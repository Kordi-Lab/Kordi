# Cross-device agent runtime and sync

This review compares the public Codex remote model, the open-source OpenClaw
mobile and macOS architecture, and Kordi's native clients. It records product
boundaries and implementation priorities; it does not assume undocumented
Codex transport details.

## Product comparison

| Product | iPhone role | macOS role | Authority and transport | Offline behavior |
| --- | --- | --- | --- | --- |
| Codex | Remote control surface for prompts, steering, approvals, and review | Connected computer owns projects, files, credentials, permissions, and tools | A secure relay connects the phone to a selected computer; the public documentation does not specify its cursor or replay protocol | The connected computer must remain online; documented chat handoff can move a chat and Git state to another host |
| OpenClaw | Gateway operator and optional capability node | Gateway owner, operator, and macOS capability node | One user-owned Gateway is authoritative; typed WebSocket RPC and events use connection generations, canonical history readback, and idempotent sends | A small per-Gateway read cache and bounded durable text outbox paint stale state immediately and retry in order |
| Kordi | Passive collaboration and agent-control client | Collaboration client and optional owner runtime | Hosted PostgreSQL state and the `/v2/chat` stream are authoritative; realtime frames wake HTTP cursor catch-up | Account-scoped message projections restore immediately; canonical replay repairs stale state |

Primary references:

- [Codex remote connections](https://learn.chatgpt.com/docs/remote-connections)
- [OpenClaw iOS app](https://docs.openclaw.ai/platforms/ios)
- [OpenClaw macOS app](https://docs.openclaw.ai/platforms/macos)
- [OpenClaw agent runtimes](https://docs.openclaw.ai/concepts/agent-runtimes)
- [OpenClaw source](https://github.com/openclaw/openclaw)

## Kordi communication path

The iPhone is a control plane for an agent runtime, not the runtime host:

```text
iPhone sends a canonical request
  -> Kordi Cloud commits the request and its sync event
  -> an eligible Mac runtime handles the request when the owner is online
     or the hosted runner claims the fallback run
  -> the executor commits the assistant result or failure as a chat message
  -> PostgreSQL wakes the chat socket
  -> iPhone replays /v2/chat/sync and publishes the durable projection
```

The desktop runtime/presence connection and the `/v2/chat/realtime` delivery
connection are deliberately separate. Only a Mac advertises execution
capability. Both clients converge through the same canonical chat history, so
the phone can disconnect during a run and recover its final state later.

## Kordi decisions

1. The iPhone never runs an agent and never publishes desktop-runtime
   presence. It submits a canonical request and displays execution on an
   available Mac or the hosted runner.
2. A socket is an accelerator, not an authority. Every socket event triggers
   ordered `/v2/chat/sync` catch-up from the last durable cursor.
3. The cursor, stream sequence, projected messages, and fork lineage are one
   local commit. A heartbeat may acknowledge only the sequence included in a
   successful atomic snapshot write.
4. Agent output, including a durable failure response, returns as a canonical
   assistant message through the same chat stream. Run lookup is only a bounded
   fallback for an exceptional terminal state.
5. A foreground lifecycle owns the realtime connection. Backgrounding,
   signing out, switching accounts, or replacing sync state cancels the socket
   and its heartbeat task.
6. A per-request runtime route is an execution input. Agent-definition routing
   is canonical, while the current ad hoc session selector is device-local. Do
   not imply cross-device route persistence until the product defines whether
   that preference is shared or deliberately local.

## Implemented optimization

The iPhone now follows the desktop chat-sync architecture:

```text
foreground / reconnect
  -> HTTP catch-up to the durable head
  -> atomically save projection + cursor + stream sequence
  -> request a single-use realtime ticket
  -> connect to the dedicated chat socket
  -> receive an event sequence
  -> HTTP catch-up and atomic save
  -> heartbeat with the last durably saved sequence
```

If realtime is unavailable, bounded exponential reconnect attempts still run
HTTP catch-up. Multiple queued socket events are coalesced because an event at
or below the already persisted stream sequence requires no additional request.
Connection generations prevent a cancelled foreground or account session from
closing or mutating its replacement, and a missed heartbeat acknowledgement
forces a clean reconnect. The previous five-second foreground chat poll and
two-second full-conversation agent poll are removed.

On the service, canonical event transactions already publish a PostgreSQL
notification. One listener per server process now fans that wake-up to open
sockets instead of every socket querying PostgreSQL every 250 milliseconds.
Sockets still read the durable stream at connect and after each heartbeat, so a
transiently lost notification changes latency but cannot create a state gap.

## Remaining priorities

### P0: durable mobile outbox

Outgoing iPhone messages preserve idempotency while a request is in memory, but
the retry intent is not yet a durable ordered outbox. Persist a bounded,
account-scoped queue and remove an item only after canonical replay confirms
its client operation ID. This is the most valuable OpenClaw pattern Kordi has
not adopted.

### P1: transactional incremental projection

The iPhone atomically replaces one account snapshot. That is crash-safe and
keeps acknowledgment honest, but it rewrites the complete projection and does
not provide desktop's incremental local transaction semantics. Move canonical
entities, inbox events, and the cursor into one SQLite transaction before chat
history grows enough for full-snapshot writes to become material.

### P1: background wake-up

Add an authenticated APNs wake path for new messages, agent completion, device
revocation, and approval requests. Push should only request a short canonical
catch-up; payload data must never become authoritative state.

### P1: define route preference ownership

Agent-definition defaults already synchronize. Decide whether per-session
model and thinking overrides are shared conversation preferences or local
composer choices. If shared, version them in canonical conversation state and
emit them through `/v2/chat`; if local, label the UI accordingly.

### P2: runtime approvals and handoff

Before exposing interactive tool approvals on iPhone, make approval state
canonical with first-committed-answer semantics and reconnect readback. A
future Mac-to-Mac handoff must transfer the agent thread and repository state,
not just the visible transcript.

## Required validation

- Reconnect after airplane mode, server restart, and app backgrounding.
- Deliver more than one sync page while the socket has queued event frames.
- Fail a snapshot write and verify the heartbeat never advances.
- Expire a cursor and verify bootstrap plus history recovery.
- Complete and fail both a Mac-owned and hosted agent run while iPhone is open.
- Revoke the iPhone device and verify the server closes realtime delivery.
- Measure wake-to-visible latency, fallback request rate, snapshot size, and
  energy use on a physical iPhone.
