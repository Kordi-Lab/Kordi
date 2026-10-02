# Chat migration history

SQL migrations in this directory are an immutable upgrade chain. Historical
filenames and table names may mention earlier chat implementations because
deployed databases have already recorded those versions. They are not active
transport choices and must not be renamed or edited after release.

Data preservation is an upgrade contract, not just a row-count check. Never erase
user names or private preferences as cleanup, or overwrite existing shared names
with generated defaults. Record and test explicit before/after semantic invariants,
including privacy boundaries, revisions, and repeated/concurrent startup.

Repair released mistakes with an additive migration and, when needed, a narrowly
scoped transactional runner guard that prevents a pending legacy cleanup. Keep
the historical SQL unchanged. Pending versions 77, 79, 80, and 81 use narrowly
scoped compatibility SQL in the runner: preserve private labels, fill only empty
shared names, retain legacy direct identities, and preserve duplicate execution
history. The original released files remain byte-for-byte unchanged and are
checked by ordinary unit tests. Version 90 repairs only proven generated defaults or empty shared
titles using authenticated public rename evidence. Existing shared names remain
authoritative. Retained private fields are audit data, never display aliases,
fallbacks, or evidence of shared titles. Only owners or administrators may name
shared channels; without public rename evidence, existing defaults remain.

Already-erased data requires a verified source backup; neither an additive schema
change nor rolling back a server image recreates it. Follow
[database upgrade validation](../../../docs/database-upgrade-validation.md) and
obtain separate production deployment authorization after rehearsal passes.

The current server exposes only the canonical chat protocol at `/v2/chat`.

Versions 92 and 93 separate mutable pin state from durable pin/unpin history. They recover
only actual actions in the retained sync journal, deduplicating shared fanout
copies and preserving their original timestamps and audience. Actions already
removed by journal retention cannot be reconstructed from the current pin.
A database trigger records future actions atomically with sync events, including
writes from older server replicas during rolling updates or rollback. History
survives sync-journal retention; conversation/account deletion still cascades.

Migration 92 installs capture before migration 93 backfills retained records,
so backfill needs no global sync-write lock and leaves no capture gap. Rehearse
the upgrade against an isolated database and take
a verified backup before an explicitly authorized production rollout. Deploy the
server before updating the macOS/iOS clients. The history API is membership-gated,
paged, and filters private actions to the actor account; existing pin-state APIs
and older clients remain compatible.

Version 116 adds the content removal schema: indexes that find the replay rows
of one message, purge columns on `cloud_attachments`, the identifier-only
`cloud_content_removal_jobs` queue, and the `cloud_content_removal_state` row.
It rewrites and deletes nothing. From this version on, "Delete for everyone",
"Remove from my view", and edits rewrite the affected replay rows in the same
transaction, and replay checks deletion and hide state when it reads. Content
changed before the upgrade stays as it is: automatic repair of changes written
by an older replica during a rolling upgrade reaches back only to the time
version 116 was applied (`automatic_since`).

Removing earlier copies is an explicit operator step. It reports counts and
changes nothing unless `--apply` is given:

```sh
kordi-cloud-server backfill-content-removal          # dry run
kordi-cloud-server backfill-content-removal --apply  # write
```

Applying it queues file removal for photos already removed from live messages,
makes the hiding account's replay rows of hidden messages content-free, marks
replay rows of earlier versions of edited messages `message.superseded`, clears
the prompts of finished digest runs, and queues one job that redacts messages
deleted in the last 91 days and removes their files when nothing else uses
them. Owners then lose access to those files. These changes remove copies and
cannot be reverted from the database, so rehearse on an isolated copy, take a
verified backup, and record the version 116 index build timings for the sync
event, message, and agent run tables before an authorized production run.

The removal worker started by `serve` works through `cloud_content_removal_jobs`
every 10 seconds: it removes stored digest copies, replaces quote previews of
deleted messages, clears agent run prompts and task summaries, archives
files-panel entries, and deletes attachment bytes that nothing else uses. It
only acts on jobs queued by a delete, hide, or edit made after version 116, by
the reconcile of such changes from an older replica, or by the operator
backfill above. Sync responses report `content_removal_version` 1 only after an
operator sets `KORDI_ATTACHMENT_BUCKET_UNVERSIONED=1` for a bucket without
versioning and a startup deletion probe succeeds. See
[`docs/data-deletion.md`](../../../docs/data-deletion.md).

Version 117 adds a nullable `removed_at` column to `cloud_session_artifacts`
and changes no existing row. The removal worker sets it with `archived_at` when
it archives a files-panel entry created from a message deleted for everyone,
or one whose file it deleted. A later publish of the same entry from a client
then leaves it archived and unlisted.
