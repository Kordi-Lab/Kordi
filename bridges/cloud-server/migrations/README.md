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

## Version numbers

Every migration has its own version. From version 106 on, the runner refuses a
database that recorded a version under a different description, so two changes
must never be given the same number. Schema changes still in review hold these
versions, and other changes must not take them:

- 110: contact consent and blocks
- 111: abuse reports
- 112: agent trust
- 116: content removal

A unit test keeps these versions free; a change that lands one of them removes
it from that list. Gaps in the sequence are allowed.

Versions 107 to 113 were renumbered before release, when chat projects took
version 107. Production databases never recorded the earlier numbers. A
development database that did is refused at startup. Such databases are
disposable, so recreate them. To keep one, renumber its records in one
transaction before starting this build:

```sql
BEGIN;
UPDATE cloud_schema_versions SET version = 113
 WHERE version IN (109, 110) AND description = 'runner run token hash';
UPDATE cloud_schema_versions SET version = 109
 WHERE version = 108 AND description = 'session-bound realtime tickets';
UPDATE cloud_schema_versions SET version = 108
 WHERE version = 107 AND description = 'account email verification';
COMMIT;
```

The build then applies version 107 and keeps every other recorded version.
