# Bridges Delivery Semantics

This document defines the current delivery semantics for the Bridges core communication flows.

Bridges currently provides **best-effort encrypted delivery with explicit fallback behavior**, not exactly-once messaging.

## Global rules

Across all message types:
- direct encrypted transport is attempted first when possible
- if direct delivery cannot be established, Bridges falls back to coordination-server mailbox relay
- success always includes at least local handoff to either direct transport or mailbox relay for a target peer
- request/response flows now also surface staged peer-side outcomes where available
- Bridges still does **not** provide application-level retries or deduplication yet
- Bridges currently does **not** guarantee total ordering across peers

## 1. `ask`

`ask` is a **single-target request/response** flow.

Current behavior:
- one target peer
- local daemon creates a `requestId`
- delivery success returns HTTP 200 from the local API plus that `requestId`
- delivery failure returns HTTP 502 and removes the pending request
- the sender can now observe staged outcomes for that `requestId` via the local daemon:
  - `handed_off_direct` or `handed_off_mailbox`
  - `received_by_peer_daemon`
  - `processed_by_peer_runtime` or `processing_failed`
- the eventual successful response is still matched by `requestId`
- pending request state remains short-lived local state, not durable coordination state

Guarantees / non-guarantees:
- no automatic retry if delivery fails or processing times out
- no dedupe if the caller repeats the request
- a peer receipt event means the peer daemon accepted the request, not that the runtime completed it successfully

## 2. `debate`

`debate` is a **fanout request/response** flow to all other project members.

Current behavior:
- one `requestId` per successfully delivered peer
- each delivered `requestId` can now advance through staged outcomes like `ask`
- if some peers receive the debate and some do not, the local API returns:
  - HTTP 200
  - `ok=false`
  - `sent_to` containing only successful peers
  - `request_ids` containing only successful request IDs
- if no peers receive the debate and at least one delivery error occurs, the local API returns HTTP 502

Guarantees / non-guarantees:
- no cross-peer ordering guarantee
- no retry for failed peers yet
- no dedupe across repeated debate submissions yet
- each peer response and failure outcome is independent and may arrive in any order

## 3. `broadcast`

`broadcast` is a **fanout fire-and-forget** message flow to all other project members.

Current behavior:
- sender attempts delivery to each other project member independently
- if some peers receive the message and some do not, the local API returns:
  - HTTP 200
  - `ok=false`
  - `sent_to` containing only successful peers
- if no peers receive the message and at least one delivery error occurs, the local API returns HTTP 502

Guarantees / non-guarantees:
- no remote acknowledgement beyond transport/mailbox handoff
- no retry for failed peers
- no dedupe across repeated broadcasts
- no global fanout ordering guarantee

## 4. `publish`

`publish` is a **fanout artifact delivery** flow to all other project members.

Current behavior:
- each recipient receives an encrypted payload containing the filename and base64 artifact data
- success/failure semantics match `broadcast`
- partial success returns HTTP 200 with `ok=false` and a successful `sent_to` list
- all-failed delivery returns HTTP 502

Guarantees / non-guarantees:
- no end-to-end acknowledgement that the remote runtime stored or used the artifact
- no retry or dedupe at this layer
- no global ordering guarantee relative to other messages

## 5. Mailbox and relay behavior

Mailbox fallback provides durable relay handoff semantics:
- mailbox entries survive restart until fetched
- successful mailbox fetch drains the returned entries
- mailbox ordering is FIFO per recipient based on stored creation order

Mailbox relay is still best-effort at the application layer:
- sender/recipient routing metadata is visible to coordination
- no application-level retry/ack/dedupe is provided beyond durable queueing before fetch

## 6. Partial-failure contract

For multi-peer operations (`broadcast`, `debate`, `publish`):
- **HTTP 200** means at least one peer was reached or no error occurred
- **HTTP 200 with `ok=false`** means partial success
- **HTTP 502** means nothing was delivered and an error occurred

Callers should therefore use:
- `status code` to detect total failure vs at-least-some delivery
- `ok` to detect full success vs partial success
- `sent_to` / `request_ids` to know exactly which peers were reached

## 7. What Bridges does not currently promise

Bridges does **not** currently promise:
- exactly-once delivery
- at-least-once delivery after remote runtime processing
- end-to-end acknowledgements for `broadcast` / `publish`
- automatic retry/backoff policy
- delivery deduplication
- causal or total ordering across peers

## 8. Test expectations

Tests should continue to verify at least the following:
- `ask` removes pending state when delivery fails
- `broadcast` returns HTTP 200 + `ok=false` on partial success
- `debate` returns only successful `request_ids`
- `publish` returns HTTP 502 when nothing is delivered
- mailbox fetch drains entries after successful fetch
