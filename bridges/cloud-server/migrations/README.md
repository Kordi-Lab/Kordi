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

## Contact consent (110)

Version 110 makes contacts mutual. A `cloud_contacts(A, B)` row means "A
accepted B"; A and B are contacts only when both rows exist and neither has
blocked the other (`cloud_accounts_are_contacts`). Rows are written only in
pairs, when a contact request is accepted, and deleted only in pairs. The
migration also adds `cloud_account_blocks`, allows the `withdrawn` request
status, and adds the SQL predicates the server uses for consent checks.

Existing one-way rows are converted once by `cloud_convert_one_way_contacts()`
(see [contacts and blocking](../../../docs/trust-and-safety/contacts-and-blocking.md)
for the user-visible result):

- self rows and one-way rows involving a Kordi service account are removed;
- a row is completed to a pair only when the peer consented: an accepted
  request between them, a pending request from the peer (now accepted), or a
  message the peer wrote themselves in their person-to-person chat;
- every other row becomes a pending request from its owner, unless one is
  already pending, the owner's latest request was declined or withdrawn, or
  either account blocked the other.

Invariants: messages, conversations, and memberships are never touched; no
push or realtime event is sent; the function is idempotent and serialized by
an advisory lock. Every change is recorded in `cloud_contact_consent_backfill`
(original row, outcome, created or accepted request ids), so it can be
reverted. Nothing deletes archive rows automatically. After at least 90 days
an operator may remove old rows with an explicit purge that only counts by
default:

```sql
-- Dry run: how many rows were recorded more than 90 days ago.
SELECT cloud_purge_contact_consent_backfill(interval '90 days');
-- Delete them. Purged rows can no longer be reverted.
SELECT cloud_purge_contact_consent_backfill(interval '90 days', true);
```

Shorter intervals are refused.

Post-deploy check (older replicas can still write one-way rows during a
rolling deploy; such rows grant nothing):

```sql
SELECT count(*) FROM cloud_contacts c
WHERE NOT EXISTS (SELECT 1 FROM cloud_contacts r
                  WHERE r.account_id = c.peer_account_id AND r.peer_account_id = c.account_id);
-- If it is not 0:
SELECT cloud_convert_one_way_contacts();
```

Rollback: an older image ignores blocks and the `withdrawn` status (it never
lists withdrawn requests). Converted requests stay pending and completed pairs
stay mutual, which an older image also understands. If a product rollback of
the conversion itself is ordered, an operator runs
`SELECT cloud_revert_contact_consent_backfill();` after a verified backup. It
restores each removed row with its original time, removes the reverse rows and
pending requests the conversion created (unless they changed since), reopens
the requests it accepted, and marks each archive row reverted, so running it
again changes nothing.

## Version numbers

Every migration has its own version. From version 106 on, the runner refuses a
database that recorded a version under a different description, so two changes
must never be given the same number, and a released description never
changes. A unit test lists every version and description from version 100 on.
Gaps in the sequence are allowed. Contact consent and blocks (110), abuse
reports (111), and agent trust (112) landed with the versions they held while
in review; no other change holds a version now.

Versions from 106 on were renumbered before release, when chat projects took
version 107, session pin stacks took version 108, and group avatars took
version 109. Session-bound realtime tickets moved to version 115 and the runner
run token hash to version 113. Account email verification moved to version 120
because content removal took versions 116 and 117. Production databases never
recorded the earlier numbers. A development database that did is refused at
startup. Such databases are disposable, so recreate them. To keep one,
renumber its records in one transaction before starting this build:

```sql
BEGIN;
UPDATE cloud_schema_versions SET version = 113
 WHERE version IN (106, 109, 110) AND description = 'runner run token hash';
UPDATE cloud_schema_versions SET version = 115
 WHERE version IN (107, 108, 109) AND description = 'session-bound realtime tickets';
UPDATE cloud_schema_versions SET version = 120
 WHERE version IN (106, 107, 108, 117) AND description = 'account email verification';
COMMIT;
```

These statements cover every earlier number of those three migrations. A
development database from the contact consent, agent trust, or content removal
change before it merged recorded them at versions 107 to 109; the statements
move those records too, and its own versions (110 and 111, 112, or 116 and 117)
already match this build. A development database that ran these changes
together before group avatars merged recorded session-bound realtime tickets
at version 109 and every other migration at its version in this build; the
statements move that record to version 115. The build then applies every
version it embeds that is still missing, such as versions 106 to 108 after the
versions that change recorded or group avatars at version 109, and keeps every
other recorded version. The statements change nothing in a database that
recorded only released versions, such as a production database at group
avatars (109). A database that recorded another migration under a number this
build uses, such as an unreleased number of chat projects or session pin
stacks, cannot be renumbered this way. Recreate it. Upgrade tests run these
statements as written here.
