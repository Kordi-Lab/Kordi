# Group Bridge Agent Stop Control Design

## Goal

Add a transcript-level stop control for the local user's running Bridge agent requests in group chats. The control should let the sender terminate a stuck or unwanted agent request without waiting for the #228 timeout.

## UI design

Use the existing chat transcript agent-turn DOM. A pending Bridge agent turn keeps the current sender meta and `Processing...` line, but adds a compact stop-square icon immediately beside the processing text. The button is always visible while pending on touch and desktop, uses `aria-label="Stop agent request"`, and disables with `Stopping…` while the cancel request is in flight.

The control appears only for the local user's own pending Bridge agent requests. It disappears for terminal states: responded, failed, timed out, or cancelled.

## Backend behavior

Cancellation is local-first and best-effort remote:

1. Call the existing `desktop_bridge_cancel_outreach(conversationId, requestId)` command.
2. Mark the matching Bridge message/outreach terminal with `delivery_state = cancelled`, `status = cancelled`, `completed_at_ms`, and `Cancelled by user`.
3. Rebuild/sync canonical sessions so refresh/restart does not resurrect a spinner.
4. Send the existing best-effort Bridge delivery event `{ state: "cancelled" }` to the remote side.

For `session-message` requests, canonical parent sync reconciles the stable `agent-response:{requestId}` agent-turn into a terminal stopped row. For delegated/recent-window requests, the delegated exchange becomes terminal and the read model shows a stopped terminal row instead of a processing row.

Late remote responses must not revive the pending spinner. If a future product decision wants to show late responses after cancellation, it should appear as a late terminal response, not a running state.

## Data flow

- Backend/canonical state exposes pending Bridge request metadata through existing canonical messages/delegated exchanges.
- Read model maps pending Bridge agent turns to `DesktopChatTurnSnapshot.pendingBridgeAgentRequest` with `conversationId` and `requestId`.
- `ChatsPage` passes an `onStopBridgeAgentRequest` handler into `MessageBubble`.
- `LiveChatTurnCard` renders the stop icon beside `Processing...` when `turn.pendingBridgeAgentRequest` exists and the turn is not completed.

## Testing

- Read model test: own pending Bridge agent request exposes stop metadata.
- Read model test: non-local pending request does not expose stop metadata.
- Read model test: cancelled delegated exchange renders terminal `Request stopped`, not processing.
- Transcript rendering test: stop button appears beside a pending turn and uses the existing live status row.
- Backend tests: cancelled Bridge agent `session-message` reconciles to a terminal stopped canonical agent-turn.
