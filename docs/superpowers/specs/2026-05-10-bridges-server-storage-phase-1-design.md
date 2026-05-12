# Bridges Server Storage Phase 0/1 Design

Implements the first half of [#332 — Design Telegram-style Bridges server storage, transactions, and cloud sync](https://github.com/Kordi-AI/Kordi/issues/332).

The issue itself prescribes the cadence: *"the initial PR should focus on measurement, indexes, transaction boundaries, and tests before introducing new cloud-sync semantics."* This spec covers Phase 0 (measurement and invariants) and Phase 1 (SQLite hot-path cleanup), split into a sequence of small PRs so each can be reviewed and reverted independently.

## Non-goals (this design)

- Server-assigned per-dialog sequence numbers and `/v1/sync` (Phase 3 of #332).
- Idempotent client send keys / recipient delivery rows (Phase 2).
- Object storage for attachments (Phase 4).
- Replacing the existing `bridges/cli` HTTP shape — Phase 0/1 stays wire-compatible.

## Sequenced PRs

### PR 1 — Schema-version infrastructure + first index (this PR)

What lands:
- New `schema_versions` table (`version INTEGER PRIMARY KEY`, `applied_at TEXT NOT NULL`).
- `apply_migration(conn, version, description, runner)` helper that runs each numbered migration exactly once, inside a transaction, and records the version on success.
- First versioned migration: a covering index on `server_mailbox(target_node_id, created_at, message_id)` so mailbox poll/ack queries can answer from the index without a row lookup.

What does **not** land:
- Migration of existing inline `add_column_if_missing` calls into the new versioned framework. Those stay where they are. The new framework is opt-in for new migrations going forward; the legacy idempotent pattern is preserved so existing databases continue to work without retrofit.

Why this scope: it adds the version tracking infrastructure (which we need for everything below) plus a single index that's measurable and reversible. The migration helper is the main load-bearing piece; once it's in, every subsequent PR can declare its own numbered migration without bespoke logic.

### PR 2 — Hot-path index pass

Add the rest of the indexes #332 calls out:
- Confirm covering coverage of every query that touches `server_mailbox` by `target_node_id`.
- Add an explicit `idx_registered_nodes_account_id` (currently the composite index is `(account_id, device_id)`; mailbox/auth lookups by account alone don't fully use it).
- Walk every `WHERE` in `bridges/cli/src/serve/*.rs` and add a one-line comment naming the index used.
- Add `EXPLAIN QUERY PLAN` assertions in tests that pin the planner to the intended index.

### PR 3 — Single-writer SQLite wrapper

Currently every HTTP handler opens its own SQLite connection (`state.open_connection()`), which `tokio` runs on the executor thread. Under contention this serializes writes through SQLite's busy timeout and starves async tasks.

Replace the per-request connection pattern with:

- A single `tokio::sync::Mutex<Connection>` in `ServerState` for writes (call it `write_conn`).
- A read connection pool (start with one extra read-only connection; bump if profiling justifies it).
- Hot-path handlers move their work into `tokio::task::spawn_blocking` so they don't park the executor.
- `run_blocking_db<F, T>(state, F) -> Result<T, E>` wrapper that takes the lock and executes `F` in a blocking task. Same pattern for `run_blocking_db_read`.

Acceptance:
- All write paths (`/v1/relay`, `/v1/broadcast`, `/v1/contacts/*`, `/v1/cloud/auth/*`, `/v1/cloud/contacts`) go through the wrapper.
- Read-only paths (`/v1/mailbox/poll`, `/v1/contacts` GET, `/v1/cloud/contacts` GET) go through the read variant.
- Existing tests stay green; an integration test fires N=64 concurrent `/v1/relay` requests and asserts no SQLite `database is locked` errors.

### PR 4 — Batched ack deletes

Today `/v1/mailbox/ack` loops one `DELETE` per `message_id`. Replace with chunked `DELETE FROM server_mailbox WHERE target_node_id = ?1 AND message_id IN (?, ?, ?, ...)` (chunked at 256 ids per statement to stay inside SQLite's parameter cap).

Acceptance:
- Existing `/v1/mailbox/ack` semantics unchanged (only acked rows are deleted, never others).
- Bench shows ≥ 5x speed-up at 100 acked ids per request.

### PR 5 — Benchmark harness (Phase 0 closer)

Add a `bridges/cli/benches/` directory with criterion-style benches for:
- relay enqueue (single recipient).
- broadcast fanout (one sender → 100 recipients).
- mailbox poll (read top-K rows for one target).
- mailbox ack (delete K rows for one target).
- cloud auth signup + login (covers password hashing as a separate metric so the rest aren't dominated by argon2).

Each bench reports `ns/iter` and `MB written` (size delta on the underlying sqlite file). Output a summary in `docs/perf/bridges-baseline-<date>.md` so future PRs can compare against it.

### PR 6 — Retention / GC

Add a `mailbox_retain_days` config (default 30) and a periodic GC task that deletes acked rows older than the threshold. Add an upper bound `MAX_MAILBOX_PER_NODE` enforcement at the index level (not via `COUNT(*)` per insert).

## Invariants this design preserves

1. **Wire compatibility.** Every Phase 0/1 PR is observable only via lower latencies and lower disk-write amplification. No HTTP body or status code changes.
2. **No data migration.** Existing SQLite files keep working. New indexes are additive; new tables (`schema_versions`) are created lazily.
3. **Idempotent migrations.** Each numbered migration is applied at most once per database. Re-running `bridges serve` is a no-op for already-applied versions.
4. **Reversible per PR.** Each PR can be reverted by dropping its commit. The `schema_versions` table is the only schema change that needs to land first; everything else is additive on top.

## Verification gate (per PR)

- `cargo test -p bridges --bin bridges` green.
- `cargo check -p bridges` clean of new warnings.
- For PR 3+: an integration test demonstrating the new property (no `database is locked`, batched ack semantics, etc.).
- For PR 5: the bench numbers checked into `docs/perf/`.
