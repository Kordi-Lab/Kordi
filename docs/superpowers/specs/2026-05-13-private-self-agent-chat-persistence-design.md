# Private Self-Agent Chat Persistence Design

## Problem

Issue #406 reports that private chats with the signed-in user's own Kordi agent disappear after relaunch. On `main-cloud`, Cloud agent runtime session ids (`cloud-agent:*`) are intentionally filtered out of local canonical sync, and the Cloud direct-agent view is only synthesized while the conversation is active. The Cloud message API also rejects self messages, so there is no durable self-scoped Cloud transcript to rebuild from.

## Goals

- Persist private chat turns with the current user's own Kordi agent locally.
- Rebuild the same private self-agent conversation after app or instance relaunch.
- Sync the transcript through Cloud for the signed-in account only.
- Avoid exposing private self-agent messages to contacts or unrelated accounts.
- Add regression coverage for restoration and self-message isolation.

## Non-goals

- Introduce a new Cloud storage table or endpoint.
- Change group agent mention behavior.
- Persist internal `cloud-agent:*` runtime scratch sessions into the canonical chat list.

## Approach

Use the existing Cloud 1:1 message table for a self-scoped private conversation by allowing `peerAccountId === session.account_id` only for normal message send/list/read operations. These rows have both `from_account_id` and `to_account_id` equal to the signed-in account, so other accounts cannot query them through the existing `(session.account_id, peer)` predicates.

On the desktop side, include the signed-in account id in Cloud message bootstrap and synthesize a self-agent Cloud Bridge conversation when messages exist for that peer. The conversation remains rendered through the existing Cloud Bridge/read-model path, but its target is the user's local Cloud agent (`cloud-local-agent` / `My Kordi`) and its runtime id remains `cloud-agent:<accountId>:<accountId>`. Runtime internals stay filtered from canonical desktop sync.

When sending a direct message to the user's own Cloud agent, `sendCloudBridgeMessage` writes the user request to Cloud as a self-message. The existing local Cloud agent processing loop can then see first-person agent mentions for the self peer, run the local runtime, and write the response back as a Cloud control response tied to the request. On relaunch, `refreshCloudBridgeMessages()` loads the self peer transcript and rebuilds the visible private agent chat.

## Data flow

1. User opens/chats with My Kordi in Cloud mode.
2. UI resolves conversation id `cloud:<accountId>:kordi-desktop` and sends to peer `<accountId>`.
3. Cloud API stores `cloud_messages(from_account_id = accountId, to_account_id = accountId, body = request)`.
4. Cloud desktop refresh includes peer `<accountId>` and lists self messages.
5. Cloud agent mention loop processes self-targeted request once, starts runtime session `cloud-agent:<accountId>:<accountId>`, and sends encoded response to peer `<accountId>`.
6. Subsequent app launch loads peer `<accountId>` messages and `buildCloudDesktopBridgeState()` synthesizes the self-agent conversation even before the user manually reopens it.

## Security

Self messages are readable only when the bearer token account id matches both sides of the stored row. The API must not allow arbitrary account ids to fetch another account's self messages. Contact-gating remains in place for non-self peer sends. No self-agent transcript is broadcast to contacts or group members unless the user explicitly uses group/mention paths.

## Testing

- Rust e2e: after signup, sending to the caller's own account returns `201`, listing with the same account returns the message, and a third account listing either side does not see it.
- TypeScript unit: Cloud message bootstrap includes the self account when self-peer messages are retained.
- TypeScript unit: `buildCloudDesktopBridgeState()` materializes a self-agent conversation from stored self messages after rebuild/relaunch, not only when active.
