# Kordi chat scale final validation — 2026-07-12

Captured on 2026-07-12 after Tasks 12–15 added post-review reliability hardening to the eleven original optimization slices. Task 16 reruns the complete Tasks 2–15 stack from the approved Task 15 head and separates deterministic automated evidence from native acceptance work that still requires a packaged Kordi build, seeded Cloud accounts, WebKit process metrics, and a real Postgres-backed Cloud server.

## Decision

- Targeted deterministic evidence passes: the benchmark meets every ceiling, including the 20,000+1 incremental Cloud-index budget, and the seven-file post-review hardening suite passes 56/56 tests.
- Standalone TypeScript typecheck, ESLint, production build, bundle budget, the 97-test serialized native canonical-session filter, script tests, and hygiene pass.
- Repository-wide status is not green. `check:frontend` has 19 failures matching the documented baseline count and categories; rustfmt reports drift in 35 files; clippy has two TUI `SessionRow` initializer errors; and the parallel desktop Rust stage hung in two Cloud file-store tests until it was interrupted. None are hidden or counted as passes.
- The native scenario matrix, WebKit latency/CPU/RSS evidence, and real-Postgres idempotency run remain pending. `DATABASE_URL` was absent for this capture.
- No GitHub issue should be closed from this report, and no issue, pull request, or external state was changed while producing it.

## Branch topology

Task 1 is an independently reversible branch from the reviewed base:

- `fix/646-transcript-anchor` at `486937c6`

Tasks 2–11 form a stack from the same reviewed base, in this order:

1. `perf/chat-scale-harness` — `3a3b5bec`
2. `perf/cloud-message-index` — `fca1fb1d`
3. `perf/linear-chat-transforms` — `e4f07942`
4. `perf/canonical-deltas` — `04419ba5`
5. `perf/cloud-sync-coordinator` — `eec92de8`
6. `fix/cloud-group-idempotency` — `820c5879`
7. `perf/canonical-catalog` — `43a35875`
8. `perf/virtual-transcript` — `53a135fc`
9. `perf/virtual-sidebar` — `91bb05a6`
10. `perf/chat-observability` — the validation and instrumentation branch containing this report

Post-review Tasks 12–16 continue that stack:

- Task 12: `perf/incremental-cloud-index` at `dae9124e` — 20,000+1 delta parse/reuse
- Task 13: `perf/incremental-cloud-cache` at `1ec7054d` — per-peer v3 cache persistence and migration
- Task 14: `perf/cloud-profile-delta` at `95130d3e` — bounded profile identity delta and adoption mutation-chain races
- Task 15: `fix/restored-outbox-delivery` at `448a0441` — exact-ID delivery delta, durable canonical acknowledgement, and parity
- Task 16: `perf/chat-scale-final-validation` — this documentation-only validation branch, based on `448a0441`

## Environment

- Machine: Apple M3 Pro, 36 GiB RAM
- Architecture: arm64
- OS: macOS 27.0, build 26A5378j
- Kernel: Darwin 27.0.0
- Node: v25.8.0
- pnpm: 10.29.3
- Rust: rustc 1.93.1 (`01f6ddf75`, 2026-02-11); cargo 1.93.1 (`083ac5135`, 2025-12-15)
- Reviewed base: `78db2b8d1a23234a421e73e3dd9e21dc1665bd04`
- Approved Task 15 head and Task 16 validation base: `448a0441721904fc50b8421f5ba95743b486fb3e`

All benchmark slices were run serially. Parallel runs were discarded because two simultaneous 67 MB fixtures distorted the Cloud median.

## Fixture and automated ceilings

The deterministic fixture contains:

- 200 spaces and 200 sessions
- 21,000 canonical messages, including a 1,000-message selected transcript
- 20,000 Cloud transport rows across 20 recipients
- 66,904,865 serialized Cloud-cache bytes
- processing/terminal pairs, tools, long thinking rows, and image attachment metadata

The Node benchmark ceilings are linear-regression guards, not substitutes for the native UX budgets:

| Metric | Ceiling |
|---|---:|
| Bridge transcript mapping | 100 ms |
| Canonical index construction | 100 ms |
| Cloud index construction over 20,000 transport rows | 4,000 ms |
| Incremental Cloud index update over 20,000+1 transport rows | 50 ms |
| Indexed delivery lookup | 5 ms |
| Serialized fixture size | 73,400,320 bytes |

## Slice benchmark results

| Slice | Bridge map | Canonical index | Cloud index | Cloud delta | Delivery lookup | Cache bytes |
|---|---:|---:|---:|---:|---:|---:|
| Harness baseline / Task 2 | 0.621 ms | 65.885 ms | 1,763.810 ms | — | 1,750.740 ms | 66,904,865 |
| Parsed-once Cloud index / Task 3 | 0.628 ms | 67.286 ms | 1,849.542 ms | — | 0.000 ms | 66,904,865 |
| Linear transforms / Task 4 | 0.700 ms | 75.877 ms | 1,854.874 ms | — | 0.000 ms | 66,904,865 |
| Canonical deltas / Task 5 | 0.578 ms | 66.497 ms | 1,852.415 ms | — | 0.000 ms | 66,904,865 |
| Sync/cache/attachment coordination / Task 6 | 0.587 ms | 67.011 ms | 1,847.129 ms | — | 0.000 ms | 66,904,865 |
| Idempotent group outbox / Task 7 | 0.580 ms | 67.787 ms | 1,851.154 ms | — | 0.000 ms | 66,904,865 |
| Canonical catalog and paging / Task 8 | 0.642 ms | 66.312 ms | 1,862.219 ms | — | 0.000 ms | 66,904,865 |
| Transcript virtualization / Task 9 | 0.581 ms | 65.239 ms | 1,844.725 ms | — | 0.000 ms | 66,904,865 |
| Sidebar virtualization / Task 10 | 0.585 ms | 65.928 ms | 1,862.215 ms | — | 0.000 ms | 66,904,865 |
| Instrumented final / Task 11 | 0.591 ms | 66.122 ms | 1,844.345 ms | — | 0.000 ms | 66,904,865 |
| Post-review hardened final / Task 16 | 0.580 ms | 65.453 ms | 1,810.387 ms | 37.529 ms | 0.000 ms | 66,904,865 |

The original material benchmark change remains delivery lookup: 1,750.740 ms in the harness baseline to below the timer’s 0.001 ms reporting resolution after the parsed index. The final benchmark now also measures a one-row update against the existing 20,000-row index. It completed in 37.529 ms under the 50 ms ceiling, and the harness aborts unless exactly one new envelope is parsed, so the measurement also enforces the incremental one-parse invariant.

### Raw JSON

Harness baseline / Task 2:

```json
{"bridgeMapMs":0.621,"canonicalIndexMs":65.885,"cloudIndexMs":1763.81,"cloudDeliveryLookupMs":1750.74,"serializedCacheBytes":66904865}
```

Task 3:

```json
{"bridgeMapMs":0.628,"canonicalIndexMs":67.286,"cloudIndexMs":1849.542,"cloudDeliveryLookupMs":0,"serializedCacheBytes":66904865}
```

Task 4:

```json
{"bridgeMapMs":0.7,"canonicalIndexMs":75.877,"cloudIndexMs":1854.874,"cloudDeliveryLookupMs":0,"serializedCacheBytes":66904865}
```

Task 5:

```json
{"bridgeMapMs":0.578,"canonicalIndexMs":66.497,"cloudIndexMs":1852.415,"cloudDeliveryLookupMs":0,"serializedCacheBytes":66904865}
```

Task 6:

```json
{"bridgeMapMs":0.587,"canonicalIndexMs":67.011,"cloudIndexMs":1847.129,"cloudDeliveryLookupMs":0,"serializedCacheBytes":66904865}
```

Task 7:

```json
{"bridgeMapMs":0.58,"canonicalIndexMs":67.787,"cloudIndexMs":1851.154,"cloudDeliveryLookupMs":0,"serializedCacheBytes":66904865}
```

Task 8:

```json
{"bridgeMapMs":0.642,"canonicalIndexMs":66.312,"cloudIndexMs":1862.219,"cloudDeliveryLookupMs":0,"serializedCacheBytes":66904865}
```

Task 9:

```json
{"bridgeMapMs":0.581,"canonicalIndexMs":65.239,"cloudIndexMs":1844.725,"cloudDeliveryLookupMs":0,"serializedCacheBytes":66904865}
```

Task 10:

```json
{"bridgeMapMs":0.585,"canonicalIndexMs":65.928,"cloudIndexMs":1862.215,"cloudDeliveryLookupMs":0,"serializedCacheBytes":66904865}
```

Task 11 final gate:

```json
{"bridgeMapMs":0.591,"canonicalIndexMs":66.122,"cloudIndexMs":1844.345,"cloudDeliveryLookupMs":0,"serializedCacheBytes":66904865,"fixture":{"spaces":200,"sessions":200,"canonicalMessages":21000,"selectedSessionMessages":1000,"cloudRows":20000,"cloudRecipients":20},"budgets":{"bridgeMapMs":100,"canonicalIndexMs":100,"cloudIndexMs":4000,"cloudDeliveryLookupMs":5,"serializedCacheBytes":73400320},"budgetFailures":[],"passed":true}
```

Task 16 final validation:

```json
{"bridgeMapMs":0.58,"canonicalIndexMs":65.453,"cloudIndexMs":1810.387,"cloudIndexDeltaMs":37.529,"cloudDeliveryLookupMs":0,"serializedCacheBytes":66904865,"fixture":{"spaces":200,"sessions":200,"canonicalMessages":21000,"selectedSessionMessages":1000,"cloudRows":20000,"cloudRecipients":20},"budgets":{"bridgeMapMs":100,"canonicalIndexMs":100,"cloudIndexMs":4000,"cloudIndexDeltaMs":50,"cloudDeliveryLookupMs":5,"serializedCacheBytes":73400320},"budgetFailures":[],"passed":true}
```

## Post-review hardening

- **Incremental index:** a 20,000-row index can be reused for a one-row delta without reparsing the old envelopes. The benchmark and focused regression both require exactly one parser call and a result below 50 ms.
- **Per-peer cache:** v3 persistence migrates legacy v1 and v2 snapshots, debounces per account, and writes only the changed peer after the initial snapshot. The 20-peer regression observed one peer record in the second write batch while preserving all 20 peers on reload.
- **Bounded profile adoption:** native adoption returns an identity delta rather than canonical full state. With 20,000 loaded messages, the tested delta excludes messages, sessions, and context snapshots, stays below 2,048 serialized bytes, and preserves the existing message-array reference. Coordinator tests cover serialized mutation chains, stale completions, and rapid A→B→A adoption.
- **Restored outbox delivery:** the durable outbox retains the exact canonical message ID through restart, including when the target is older than the newest 200 rows. Delivery uses an exact-ID bounded native delta, then keeps the outbox entry in an awaiting-ack phase until the canonical acknowledgement is durable; renderer/native parity tests cover the two-phase path.

## Privacy-safe performance spans

The renderer now records these spans:

- `cloud-message-index`
- `canonical-catalog-ipc`
- `canonical-page-ipc`
- `session-click-to-first-message`
- `transcript-virtual-render`
- `sidebar-virtual-render`
- `cloud-send-to-first-ack`

Each record has only a fixed span name, duration, numeric counts, and payload byte sizes. Message text, account IDs, session IDs, tokens, and attachment URLs cannot enter the emitted metric schema. Session IDs used to correlate a click with its transcript remain module-private and are not emitted.

Development builds enable the spans automatically. A production diagnostic build remains off unless one of these explicit switches is used:

```text
VITE_KORDI_PERF_DIAGNOSTICS=1
globalThis.__KORDI_PERF_DIAGNOSTICS__ = true
localStorage.setItem('kordi:performance-diagnostics', '1'); location.reload()
```

Records are available as `kordi:<span-name>` Performance entries, `[kordi-performance]` console records, and `kordi:performance-span` window events. The in-memory buffer is capped at 500 records. Cloud index payload size is summed from wire bodies with a zero-allocation UTF-8 counter; diagnostics do not stringify the whole Cloud cache.

## Automated validation

| Gate | Result |
|---|---|
| `pnpm --dir app/desktop bench:chat-scale` | Pass; all ceilings met, including 37.529 ms < 50 ms for the 20,000+1 delta and exactly one new parse |
| Seven-file final-hardening suite | Pass, 56/56 across `tests/cloudMessageIndexPerformance.test.ts`, `tests/cloudMessageCache.test.ts`, `tests/canonicalStateReducers.test.ts`, `tests/cloudSyncCoordinator.test.ts`, `tests/cloudGroupOutbox.test.tsx`, `tests/cloudGroupNormalSendPath.test.ts`, and `tests/nativeCanonicalSessionPerformance.test.ts` |
| `pnpm --dir app/desktop typecheck` | Pass |
| `pnpm --dir app/desktop lint` | Pass |
| `pnpm --dir app/desktop build` | Pass; six-chunk bundle budget passes, largest chunk 588.88 kB |
| `cargo test -p kordi-desktop --no-default-features canonical_sessions -- --test-threads=1` | Pass, 97/97; 160 filtered out |
| `pnpm test:scripts` | Pass, 18/18 |
| `pnpm check:hygiene` | Pass |
| `git diff --check` | Pass before and after documentation update |
| `pnpm check:frontend` | Fail, exit 1 in the unit stage: 1,118/1,137 pass and 19 tests match the documented baseline categories; the chained typecheck/lint/build stages therefore do not run in this command |
| `pnpm check:rust:fmt` | Fail, exit 1: repository-wide formatting drift in 35 unique Rust files, including files outside this stack |
| `pnpm check:rust:clippy` | Fail, exit 101: exactly two missing `parent_session_message_id` fields in TUI `SessionRow` test initializers at `agent/crates/tui/src/session_selector.rs:109` and `:121` |
| `pnpm check:rust:test` | Interrupted, exit 130: dependency check passed; core stages passed 50/50, 196/196, and 22/22; the 257-test parallel desktop stage never summarized because exactly two Cloud file-store tests hung for more than 4m20s |
| Serialized Cloud file-store classification | Pass, 2/2 across two separate one-test commands; each had 256 tests filtered out |

The production bundle passed with six JavaScript chunks. The largest was `cloud-features-C6dqeNaK.js` at 588.88 kB, within the repository’s configured budget. Vite also emitted a warning that `%VITE_KORDI_EDITION%` was not defined; it did not fail the build or its bundle-budget check.

The 19 frontend failures match the previously documented baseline count and remain snapshot/source-contract mismatches in unrelated Cloud avatar/auth copy, LM Studio error copy, participant-space/task expectations, viewport source assertions, shared-agent naming, and participant-context expectations. The fresh unit run contains five more tests than the earlier report: 1,137 total, 1,118 passed, and 19 failed.

The parallel desktop Rust result is not reported as a pass. The two tests `cloud_session_uses_app_data_file_store_when_isolated_dev_instance_is_running` and `cloud_device_key_uses_stable_app_data_file_store` both exceeded 60 seconds and were still blocked after more than 4m20s, so the command was interrupted. Each exact test then executed and passed immediately when rerun alone with one test thread, classifying the failure as the known shared-environment file-store race without turning the aggregate gate green.

## Native acceptance matrix

The following scenarios were not run in this non-interactive worktree session. They need a packaged native build, seeded accounts, WebKit process observation, and—in the send cases—a real Postgres-backed Cloud server. An unrun test is not treated as a pass.

| Scenario | Automated proxy now available | Native status |
|---|---|---|
| Cold login with stale v1 cache | v1/v2→v3 per-peer cache migration and catalog/page tests | Pending |
| Warm relaunch from v3 cache | async per-peer cache/store tests | Pending |
| Reactivation after five minutes | sync coordinator focus/pageshow tests | Pending |
| 50 switches between 1,000-message group and short direct chat | session paging and virtual transcript tests | Pending CPU/RSS capture |
| Scroll newest→oldest→newest | variable-height prepend/jump tests | Pending native visual run |
| Send to 20 recipients with one transient failure | durable exact-ID outbox partial-success/retry and two-phase acknowledgement tests | Pending real Cloud run |
| Restart before retry | durable exact-ID restore and acknowledgement-phase tests | Pending packaged restart run |
| Open visible image previews without startup content hydration | metadata-only/lazy attachment tests | Pending network trace |

`bridges/cloud-server/tests/cloud_auth_e2e.rs` contains real-Postgres idempotency cases, but those tests return early when `DATABASE_URL` is absent. No database was configured for this capture, so those cases are not claimed as executed evidence.

## Product budget status

| Product budget | Evidence | Status |
|---|---|---|
| One-row Cloud index update < 50 ms | 37.529 ms over 20,000+1 rows; exactly one new envelope parsed | Pass (automated) |
| Cache update writes only the changed peer | 20-peer v3 cache regression writes one peer record after initial snapshot | Pass (automated) |
| Profile adoption avoids a full-state reload | < 2 KiB identity delta with 20,000 loaded messages; no messages, sessions, or context snapshots | Pass (automated) |
| Restored outbox updates an old canonical target by exact ID | Durable restart regression targets a message older than 200 newer rows and retains it through canonical acknowledgement | Pass (automated) |
| Warm click to first message p95 < 100 ms | Instrumentation added | Pending native sample |
| Cold catalog + first page < 500 ms | Bounded native query test + instrumentation | Pending packaged timing |
| No selection long task > 50 ms | Virtual/paged code and instrumentation | Pending WebKit trace |
| Optimistic text < 50 ms | Existing optimistic path retained | Pending native timing |
| Retry does not duplicate server message | Outbox tests pass; SQL uniqueness and server tests exist | Pending real Postgres e2e |
| Catalog < 1 MiB | 20,000-row native serialization regression passes | Pass (automated) |
| First page ≤ 150 rows and < 512 KiB | Native serialization regression passes | Pass (automated) |
| Transcript rows ≤ 60 | 1,000-row JSDOM regression passes | Pass (automated) |
| Sidebar rows ≤ 80 | 500-row JSDOM regression passes | Pass (automated) |
| Idle CPU < 1% | Requires WebKit process sample | Pending |
| RSS < 350 MiB and stable across 50 switches | Requires WebKit process sample | Pending |
| No synchronous history localStorage writes after migration | async per-peer v3 cache tests/source guard | Pass (automated) |

## Issue closure rules

- **#634:** do not close until the 20-recipient native send and real-Postgres idempotent partial-retry run pass.
- **#638:** do not close until native click/send p95s pass, logs contain no `database is locked`, and the IPC trace confirms no full-state click request.
- **#655:** do not close until cold, warm, and reactivation runs show neither stale unread flashes nor an empty selected shell.
- **#646:** do not close until the packaged variable-height open/scroll/prepend/jump matrix shows no blank viewport.
- **#633:** close last, only after all latency, payload, DOM, CPU, and RSS gates pass.

No issue or pull request was created, closed, or otherwise changed, and no external state was changed while producing this report.
