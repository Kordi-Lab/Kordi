# Data deletion

This page records what the Cloud server keeps and removes when a person deletes
a message for everyone, removes it from their own view, or edits it. It is the
claim register for the deletion wording in the desktop and iOS apps: every
sentence the apps show about deletion maps to a row below, and the apps show the
storage sentence only when the server reports `content_removal_version` 1 or
higher.

Code: `bridges/cloud-server/src/chat_sync/store/redaction.rs` (in-request
rewrites), `bridges/cloud-server/src/chat_sync/removal.rs` (background worker),
`bridges/cloud-server/src/chat_sync/store/quote_redaction.rs` (quote previews),
and `bridges/cloud-server/src/digest/redaction.rs` (digests). Schema:
`bridges/cloud-server/migrations/0116_content_removal.sql`.

## What each action does

### Delete for everyone

Only the sender can delete a message for everyone. In the same transaction as
the deletion:

1. The message row is emptied. Attachment links, reactions, and reactions on
   its photos are removed.
2. Every member receives a content-free `message.deleted`.
3. Every retained replay row that still carried a snapshot of the message, in
   every account's stream, becomes a content-free `message.deleted`.
4. Agent runs for the message that have not started are cancelled with an
   empty prompt.
5. A removal job is queued with the message's identifiers and attachment ids.

Replay also checks deletion state when it reads, so a row written by an older
server never returns removed content.

The removal job runs within seconds and retries until it finishes:

- Stored digests drop the message and every item that cites it.
- Replies that quoted it or opened a thread on it show "Original message was
  deleted".
- Prompts of agent runs requested by it are cleared, and queued runs are
  cancelled. A run already working on it keeps its prompt until it ends; the
  job clears it then.
- Task summaries recorded from it are cleared, and files-panel entries created
  from it are archived.
- Each attachment it used has its bytes deleted from object storage unless
  another message that is not deleted, a saved sticker or GIF, or an agent run
  artifact of a message that is not deleted still uses it.

New agent runs for a deleted request are refused with `context_unavailable`.

### Remove from my view

Any member can remove a message from their own view:

- The message is hidden on all of that account's devices.
- That account's retained replay rows of the message become content-free
  `message.hidden`.
- Later changes reach that account only as a content-free `message.hidden`, and
  reaction updates are not sent there.
- That account's digest drops the message.
- Nothing changes for other members.

### Edit

When the sender edits a message's text:

- Every retained replay row carrying an earlier version, in every account's
  stream, becomes a content-free, noncritical `message.superseded`, which
  clients ignore. The newest row for each member carries the current version.
- Digests drop the earlier version.
- Replies that quoted the message keep the wording they quoted.

## Claim register

| In-app sentence | Where it is shown | What makes it true |
| --- | --- | --- |
| "Removes it for everyone in this chat, and Kordi deletes its text and files from chat storage." | Delete for everyone, group, version 1 or higher | Delete for everyone above; rows "Replay journal", "Messages", "Files" |
| "Removes it for you and {name}, and Kordi deletes its text and files from chat storage." | Delete for everyone, direct and AI chats, version 1 or higher | Same as above |
| "Removes it for everyone in this chat. Copies may remain on the server." | Delete for everyone, version 0 or field missing | Makes no storage claim |
| "Hides it on your devices. Others in the chat still see it." | Remove from my view | Remove from my view above |
| "People who already saw it may have saved a copy or taken a screenshot. If an agent already read it, the agent's reply and what it received stay." | Footnote of the delete choices | Row "Not covered" |
| "Removes this photo for everyone in this chat, and Kordi deletes the file from chat storage." | Delete photo for everyone, version 1 or higher | Row "Files"; the photo's file follows the same rule as a message's files |
| "Removes this photo for everyone in this chat. Copies may remain on the server." | Delete photo for everyone, version 0 | Makes no storage claim |
| "Original message was deleted" | A reply whose quoted or threaded source was deleted for everyone | Row "Quote and thread previews" |
| "This doesn't delete its messages for anyone. The chat comes back when a new message arrives." | Remove chat | Removing a chat only hides it from the account's list |

The apps never use "permanently", "from all servers", "securely erased", "gone
forever", any backup claim, or a score.

## What is kept and for how long

| Record | Policy |
| --- | --- |
| Replay journal | Kept 60 days by default (30 to 90, `KORDI_CHAT_SYNC_RETENTION_DAYS`) and trimmed every 6 hours. Deletes, hides, and edits rewrite it at the moment of the change. Replay checks deletion and hide state on read. A background check every 10 minutes repairs deletes and hides made by an older server during an upgrade. Edits made by an older server during an upgrade keep the earlier wording until those records expire. |
| Messages | Kept until deleted for everyone. The deleted message keeps only its id, client id, conversation, sequence, sender, kind, reply and thread linkage, version, and created, edited, and deleted times. |
| Files | Kept while a message that is not deleted, a saved sticker or GIF, or an agent run artifact of a message that is not deleted uses them. Otherwise deleted from object storage, usually within a minute. Reads are denied for everyone, the owner included, before the bytes are deleted. Files kept for another use are checked again at least daily, and at once when the saved sticker or GIF that kept them is removed. The attachment row keeps its id, owner, object key, content type, size, and timestamps; its hash and preview are cleared. |
| Digests | When a message is deleted for everyone, edited, or removed from a person's view, the digest stops showing anything that cites it at once (existing read check). Within one removal-job cycle, stored digest items that cite it and stored copies of its text are removed, and any digest run in progress that included it is stopped. The digest regenerates at its next refresh. This does not depend on the model provider being available. Finished digest runs keep no prompt. |
| Quote and thread previews | Replaced for deletions: the preview text, mentions, and attachment count are emptied and the source is marked deleted. After an edit, replies keep the wording they quoted. Forwards are separate messages and are not changed. |
| Agent runs | Requests are cleared, queued runs are cancelled, and new runs for a deleted request are refused. |
| Tasks | Task summaries from a deleted reply are cleared. Earlier journal copies expire with the journal. |
| Files panel | Entries created from a deleted message, or pointing at a deleted file, are archived and no longer listed, even if a client publishes them again. |
| Kept records | The one-way request fingerprint, which stops a retried send from recreating a deleted message, and removal job records, which hold identifiers only and are not trimmed yet. |
| Not covered | Copies on devices, downloads, and screenshots. Saved stickers and GIFs, which keep their file. Forwards and forked chats. What an agent already received, and its reply. Prompts of other runs that included the message as history. Agent workspace files, which are **kept indefinitely** today: sandbox expiry does not delete them. Delivered notifications. Uploads that were never sent. Older `task.upsert` journal copies of a cleared task summary, which expire with the journal. Server backups and model providers' own retention. Content deleted, hidden, or edited before this release until an operator applies the history backfill below; messages deleted more than 91 days before it get no file deletion or quote repair, because their identifiers are gone. A reply an agent is still writing when a quoted message is deleted may restore the preview until it finishes. |

## Operations

### Reported version and attestation

The server reports `content_removal_version` 1 only when all of these hold:

- object storage is configured (`S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`,
  `S3_SECRET_KEY`);
- `KORDI_ATTACHMENT_BUCKET_UNVERSIONED=1` is set;
- a deletion probe of a random `content-removal-probe/<uuid>` key returned 2xx
  or 404; and
- the removal worker is running.

Set `KORDI_ATTACHMENT_BUCKET_UNVERSIONED=1` only after confirming that the
attachment bucket has no versioning (`mc version info <alias>/<bucket>` or the
provider's equivalent) and that the server's credentials allow
`s3:DeleteObject`. With versioning on, a deletion only adds a delete marker and
earlier versions stay. The loopback development stack in
`deploy/dev/compose.yaml` sets it because its bucket is created by `mc mb`
without versioning. Do not set it in a production manifest without that check.

Until then the server reports 0, the apps show the conservative wording, and
the worker still removes copies and deletes files. The worker probes at
startup and every hour while the version is 0, and logs one line:

```text
[content-removal] readiness object_store=true attested=true probe=ok ready=true
```

A deletion refused with HTTP 403 sets the version back to 0 until the next
successful probe.

### Worker

Every 10 seconds the worker runs up to 20 due jobs. Each job runs its pending
steps in the order digests, records, attachments, quotes; a failing step does
not stop the others. Failed attempts wait 30 seconds, doubling up to 6 hours,
and jobs never give up. Without object storage, the attachments step waits with
`object_store_unavailable` and nothing is marked deleted. Log lines carry ids,
reasons, steps, and codes only:

```text
[content-removal] job=<id> reason=<reason> step=<step> outcome=<done|more|retained|error:<code>>
```

Error codes are `database_error`, `object_store_unavailable`,
`object_store_forbidden`, and `object_store_error`. A job is logged again when
it reaches 10 failed attempts. To see the backlog:

```sql
SELECT reason, count(*), max(attempts), min(created_at)
FROM cloud_content_removal_jobs WHERE completed_at IS NULL GROUP BY reason;
```

### History backfill

Starting a new server never rewrites or deletes content changed before version
116 was installed. Removing those earlier copies is an explicit operator step,
off by default, that reports counts without `--apply`:

```sh
kordi-cloud-server backfill-content-removal          # dry run
kordi-cloud-server backfill-content-removal --apply  # write
```

Applying it queues file deletion for photos already removed from live
messages, makes the hiding account's replay rows content-free, marks replay
rows of earlier edited versions `message.superseded`, clears finished digest
run prompts, and queues one job that redacts messages deleted in the last 91
days, deletes their files when nothing else uses them, and repairs stored
digests. Owners then lose access to those files, which they keep today. These
changes remove copies and cannot be reverted from the database: rehearse on an
isolated copy and take a verified backup first.

### Rehearsal

Version 116 builds indexes on the replay journal, messages, and agent runs
inside the migration transaction, which holds write locks while they build.
Before an authorized production rollout, apply it to a copy of production per
[database upgrade validation](database-upgrade-validation.md) and record the
build time of each index here:

| Index | Table | Rows | Build time |
| --- | --- | --- | --- |
| `idx_cloud_chat_sync_events_entity` | `cloud_chat_user_sync_events` | not yet measured | not yet measured |
| `idx_cloud_chat_messages_deleted` | `cloud_chat_messages` | not yet measured | not yet measured |
| `idx_cloud_agent_fallback_runs_session_request` | `cloud_agent_fallback_runs` | not yet measured | not yet measured |
