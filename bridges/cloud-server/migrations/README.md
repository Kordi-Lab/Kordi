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
reverted. Nothing in this release deletes archive rows.

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
