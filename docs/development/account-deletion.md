# Account deletion

`POST /v1/cloud/account/security/delete` deletes the signed-in account. It
takes the same proof as the other [account security](account-security.md)
changes: `currentPassword` when the account has a password, otherwise
`verificationId` and `verificationCode` from `POST /password/code`, or a
sign-in within the last ten minutes. It answers `204`, and every session and
token of the account stops working at once.

```json
{ "currentPassword": "…" }
```

Errors are the security page's: `current_password_required`,
`reauthentication_required`, `invalid_current_password`, code errors,
`account_changed` (the password or email changed meanwhile), and
`rate_limited`. An emailed code is spent before anything is removed, so a
wrong code changes nothing.

## What happens

Owner decision B1: people keep what they wrote to each other, but nothing
identifies the deleted person.

- **Groups other people are still in** are kept. A group the person owned
  passes to the longest-standing admin, else the longest-standing active
  member, in each of its conversations. Their messages stay and are shown
  as **Deleted account**: they move to the server-managed stand-in account
  `acct_kordi_deleted` ([`src/deleted_account.rs`](../../bridges/cloud-server/src/deleted_account.rs)),
  which joins the conversation as a member who left so clients can name the
  sender. Their name, handle, avatar and email are scrubbed from every stored
  message of the conversation (group envelopes list every participant), and
  their attachments are removed from the messages. Free text that mentions
  them by name is not rewritten.
- **Direct conversations** lose every message, plan card and call. The
  other person is removed, so their devices drop the conversation; the empty
  row stays only so that removal reaches them through the sync stream.
- **Conversations with no other active person** are deleted.
- **Everything else the account owns** is deleted with the account row:
  uploads, avatars, memories, connectors, agents, runs, scheduled tasks,
  devices, sessions, contacts, Grounding cards, and the personal
  organization. Other organizations lose the member; when the last owner
  goes, the longest-standing admin is promoted (migration 0168).
- Plan cards and agent-session requests they made in conversations others
  keep, and comments they left on other people's documents (with the replies
  to them), are kept from the stand-in.
- Other people's digests built from their messages are cleared and rebuilt
  without them, synced copies of emptied direct conversations are deleted,
  and access waitlist requests under any of their emails are removed.

Remaining members get `membership.updated` for each kept conversation and
`message.updated` for up to 200 of its newest changed messages; older
changed messages load the new way. The other person in a direct conversation
gets `membership.removed`.

## Order of work

1. A short transaction locks the account, checks that its password and email
   are unchanged since the proof was checked, and spends an emailed code.
   Then, outside any transaction, connectors are revoked at their providers
   while their credentials still exist, and Sign in with Apple tokens are
   revoked with Apple (`account_deletion::prepare`). Failures are logged and
   never stop the deletion.
2. One transaction locks and checks the account again, moves or deletes conversations, clears
   rows that point at the account's attachments, sandboxes or personal
   organization, deletes records that have no foreign key
   (`cloud_audit_events`, `cloud_agent_omp_state`, `cloud_connector_audit`,
   `cloud_connector_removal_requests`), queues object-store keys in
   `cloud_object_deletions`, moves Apple tokens that could not be revoked to
   `cloud_apple_token_revocations` for a retry worker, deletes the account row, and writes the
   `account.deleted` audit event with counts only.
3. After commit every device's live connections are closed, contacts' devices
   are told the contact is gone, and queued objects are deleted. A failed
   object delete stays queued and is retried with backoff by a background
   worker; a missing object counts as deleted.

Migration 0179 lets the account's project devices and commands, agent
exchanges, and references from other people's runs follow the deletion.
Foreign keys to kept conversations, messages and plan cards stay strict, so a
row the server failed to move makes the deletion fail instead of silently
disappearing.
