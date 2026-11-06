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
- Blocks and unblocks share a budget of 60 changes per hour (429
  `rate_limited`).

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
| Contact request or the older one-sided add | 403 `contact_request_unavailable` for the blocked side, 409 `blocked_account` for the blocker (checked again under the pair lock before the row is written) |
| Accepting a request decided after a block | 409 `contact_request_unavailable` |
| Writing, editing, or adding a reaction (to a message or a photo) in a direct or AI conversation they share | 403 `CHAT_BLOCKED` (removing one's own reaction and deleting one's own message still work) |
| Starting a conversation with, or adding to a group, the other account | 403 `CHAT_BLOCKED` |
| Joining a group through the other's invite link | 403 `group_invitation_unavailable` (links other admins made still work) |
| Starting a Grounding group with the other account | 400 `common_ground_invalid_group`, which names nobody |
| Looking the other account up by id or Kordi ID | 404 `account_missing` |
| Asking the other's default or shared agents (claims, agent hand-offs, document mentions) | refused like any agent that is not available |
| Starting a direct call | 403 `CALL_FORBIDDEN` |
| Starting or ringing again a group meeting | the other account is left out of the meeting |
| Grounding nearby people, alerts, cards, links, and recent matches | the other account is not shown |
| Digest sources and proactive agent context | the other account's messages are left out |

In groups they share nobody is removed and both can keep writing. For the
blocker:

- the blocked account's messages do not count toward unread totals;
- there is no push notification for them (an agent's messages count for its
  owner), and calls the blocked account starts or rings do not ring the
  blocker's devices;
- the iPhone and Mac apps collapse each of them to a row reading "Message
  from a blocked account" that shows the message when tapped, and show no
  in-app alert for them. On iPhone the author is matched by name; an alert
  is hidden only when the message is already on the device.

Removing a contact keeps the direct conversation and its history, so the
direct-message check reads the block table itself rather than contact rows.

Unblocking lets either side send a contact request again.

## Known limitations

- A blocked person can infer the block from refused requests and messages.
- Invite links created by other admins still let a blocked person join a group
  the blocker is in; the blocker can leave that group.
- The System agent in a shared group still reads everyone's messages; it
  works for the group, not for one member.
- Thread panels on the Mac and direct conversations do not collapse messages,
  because a direct conversation with a blocked account is read-only.
- Blocking does not send anything to Kordi. Reports do; see
  [abuse reports](abuse-reports.md).

## Account deletion

`cloud_account_blocks` rows reference both accounts with `ON DELETE CASCADE`,
so deleting either account removes its blocks.
