# Blocking

People can block anyone except themselves and Kordi service accounts (System,
the System agent, and Kordi Support). The block list is private to the blocker,
and the blocked person is never told. The server enforces every rule here;
clients only present them.

## API

All routes need a signed-in session.

- `GET /v1/cloud/blocks` returns
  `{ "blocks": [ { "accountId", "kordiId", "displayName", "avatarUrl", "blockedAt" } ] }`,
  newest first.
- `PUT /v1/cloud/blocks/:account_id` blocks the account and returns
  `{ "block": { ... }, "removedContact": bool }`. It is idempotent. Errors:
  400 `self_block`, 400 `cannot_block_service`, 404 `account_missing`.
- `DELETE /v1/cloud/blocks/:account_id` unblocks and returns 204. It is
  idempotent and does not add the contact back.

Both block changes append `account.directory.changed` (with `reason`
`blocked` or `unblocked`) to the blocker's own sync stream only.

## What a block does

When someone blocks another account, in one transaction under a per-pair lock:

- both contact rows and the accepted request between them are removed (the
  same live `contact.removed` refresh a contact removal sends);
- a pending request from the blocked account is rejected, and the blocker's
  own pending request to them is deleted, without telling anyone;
- ringing or active voice and video calls in their direct conversation end.

From then on, in both directions:

| Action | Result |
| --- | --- |
| Contact request or the older one-sided add | 403 `contact_request_unavailable` for the blocked side, 409 `blocked_account` for the blocker |
| Accepting a request decided after a block | 409 `contact_request_unavailable` |
| Writing or adding a reaction in a direct or AI conversation they share | 403 `CHAT_BLOCKED` (removing one's own reaction still works) |
| Starting a conversation with, or adding to a group, the other account | 403 `CHAT_BLOCKED` |
| Joining a group through the other's invite link | 403 `group_invitation_unavailable` (links other admins made still work) |
| Starting a Grounding group with the other account | 403 `blocked` |
| Starting a direct call | 403 `CALL_FORBIDDEN` |
| Ringing again in a group meeting | the other account is skipped |

In groups they share nobody is removed and both can keep writing. The blocker
gets no push notification for the blocked account's messages (an agent's
messages count for its owner), and calls the blocked account starts or rings
do not ring the blocker's devices.

Removing a contact keeps the direct conversation and its history, so the
direct-message check reads the block table itself rather than contact rows.

Unblocking lets either side send a contact request again.

## Known limitations

- A blocked person can infer the block from refused requests and messages.
- Invite links created by other admins still let a blocked person join a group
  the blocker is in; the blocker can leave that group.
- Blocking does not send anything to Kordi. Reports do; see
  [abuse reports](abuse-reports.md).

## Account deletion

`cloud_account_blocks` rows reference both accounts with `ON DELETE CASCADE`,
so deleting either account removes its blocks.
