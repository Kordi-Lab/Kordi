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
