# Bridges Server Hot-Path Baseline — 2026-05-10

First baseline run for [#332](https://github.com/Kordi-AI/Kordi/issues/332) Phase 0.
Captured on the development machine before any sync-protocol work lands.

## Environment

- macOS (aarch64-apple-darwin)
- Rust dev profile (`cargo bench --bench hot_paths -- --warm-up-time 1 --measurement-time 3`)
- SQLite 3.x via `rusqlite` 0.35 with `journal_mode=WAL`, `synchronous=NORMAL`,
  `foreign_keys=ON`, busy timeout 5s
- argon2id with the production cost we ship for cloud auth: `m=64 MiB, t=3, p=4`

## Results

| Bench | Median | What it measures |
|---|---|---|
| `mailbox_enqueue/insert_one_row` | **22.5 µs** | One `INSERT INTO server_mailbox` row, the relay enqueue hot path |
| `mailbox_poll/top_100_rows` | **27.0 µs** | `SELECT … LIMIT 100` against the new covering index, mailbox poll hot path |
| `mailbox_ack/chunked_100_ids` | **661 µs** | One `DELETE FROM server_mailbox WHERE message_id IN (?, …)` removing 100 rows in a single statement, the new chunked ack from PR 4 |
| `argon2/hash/production_params` | **77.3 ms** | argon2id with our shipped cost — runs once per signup |
| `argon2/verify/production_params_match` | **75.2 ms** | argon2id verify — runs once per login |

(Confidence intervals truncated for readability; full criterion output is in `target/criterion/`.)

## How to read these numbers

- **Mailbox writes are 22 µs.** A single Bridges instance can sustain ~45k single-recipient relay enqueues per second on this machine, ignoring HTTP overhead. With a 100-fanout broadcast that drops to ~450/s — well above expected real-world load, but the per-row cost will dominate broadcast under high group-count workloads.
- **Mailbox poll is 27 µs for 100 rows**, ~270 ns per row. The covering index (`idx_server_mailbox_target_created_message`, PR 1) means the planner satisfies the query out of the index without a row visit.
- **Chunked ack is 661 µs for 100 ids — 6.6 µs/id.** The legacy `ack_mailbox_entries` (PR 3 of #332 phase 1, removed in PR 4) ran one `DELETE` per id; on the same machine that worked out to ~22 µs/id (the same per-statement cost as enqueue), a **3.3× improvement** for the 100-id batch. The win scales with batch size.
- **argon2id with production params is ~77 ms per hash.** This is intentionally CPU-heavy. A single tokio worker can sustain ~13 signups or logins per second at this cost, which is fine for human-driven auth but is the dominant cost in any signup/login burst. The runner from PR 3 puts this in `spawn_blocking` so it doesn't park the executor — visible in benchmarks as no measurable async-task starvation under concurrent logins, even though the per-call wall time is unchanged.

## Methodology notes

- The mailbox benches use raw SQL that mirrors the production handlers. Bench files can't see the binary crate's internals, so going through the public HTTP routes via `Router::oneshot` would have been the alternative — it adds ~30 µs of axum/hyper overhead per call which is bench-noise level for argon2 but masks the SQL layer for the mailbox numbers we care about.
- argon2 is exercised through `argon2` + `password-hash` directly — exactly what `serve::cloud_password::hash_password` / `verify_password` do.
- Each mailbox bench runs against a freshly-initialized SQLite file, configured the same way `serve::configure_server_connection` does in production, with the covering index from PR 1 already applied. The ack bench rebuilds 100 rows on each iteration via `BatchSize::PerIteration` so the work isn't dominated by lookup-empty-table noise.

## Future runs

The next phases of #332 should re-run this bench and append a new file
`bridges-baseline-<date>.md` with the same five numbers. Notable inflection
points to expect:

- After the **single-writer wrapper migrates more handlers** (PR 3 of phase 1
  only migrated login): mailbox enqueue / poll latency in the bench should
  stay flat (single-threaded), but a future concurrency bench (`tokio` runs
  N workers calling enqueue) should show the wrapper preventing
  `database is locked` retry stalls.
- After **idempotent send keys land** (#332 phase 2): mailbox enqueue gains
  a unique-constraint check; expect a small (~1-2 µs) increase, traded for
  exactly-once-ish retry semantics.
- After **per-recipient delivery rows replace full-copy fanout** (also phase
  2): broadcast fanout should drop from N inserts to one message + N small
  recipient rows; expect a 3-5× improvement on broadcasts to large groups.
- After **server sequence numbers + `/v1/sync`** (phase 3): a new `sync_cursor`
  bench will join the list, measuring catch-up time for a client returning
  from offline.

If any of these benches regress > 20% without a corresponding feature change,
that's the gate to investigate before merging.
