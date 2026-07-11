# Kordi chat scale validation — 2026-07-10

Captured on 2026-07-11 after the eleven optimization slices were implemented. This report separates deterministic automated evidence from native acceptance work that still requires a packaged Kordi build, seeded Cloud accounts, and WebKit process metrics.

## Decision

- The deterministic benchmark passes its regression ceilings.
- The focused chat reliability suite passes 88/88 tests.
- TypeScript typecheck, ESLint, production build, bundle budget, script tests, and hygiene pass.
- The repository-wide frontend and Rust gates still contain baseline failures described below. None are hidden or counted as passes.
- No GitHub issue should be closed from this report yet. The native scenario matrix and real-Postgres idempotency run remain required.

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

## Environment

- Machine: Apple M3 Pro, 36 GiB RAM
- Architecture: arm64
- OS: macOS 27.0, build 26A5378j
- Kernel: Darwin 27.0.0
- Node: 25.8.0
- pnpm: 10.29.3
- Rust: rustc/cargo 1.93.1
- Reviewed base: `78db2b8d1a23234a421e73e3dd9e21dc1665bd04`

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
| Indexed delivery lookup | 5 ms |
| Serialized fixture size | 73,400,320 bytes |

## Slice benchmark results

| Slice | Bridge map | Canonical index | Cloud index | Delivery lookup | Cache bytes |
|---|---:|---:|---:|---:|---:|
| Harness baseline / Task 2 | 0.621 ms | 65.885 ms | 1,763.810 ms | 1,750.740 ms | 66,904,865 |
| Parsed-once Cloud index / Task 3 | 0.628 ms | 67.286 ms | 1,849.542 ms | 0.000 ms | 66,904,865 |
| Linear transforms / Task 4 | 0.700 ms | 75.877 ms | 1,854.874 ms | 0.000 ms | 66,904,865 |
| Canonical deltas / Task 5 | 0.578 ms | 66.497 ms | 1,852.415 ms | 0.000 ms | 66,904,865 |
| Sync/cache/attachment coordination / Task 6 | 0.587 ms | 67.011 ms | 1,847.129 ms | 0.000 ms | 66,904,865 |
| Idempotent group outbox / Task 7 | 0.580 ms | 67.787 ms | 1,851.154 ms | 0.000 ms | 66,904,865 |
| Canonical catalog and paging / Task 8 | 0.642 ms | 66.312 ms | 1,862.219 ms | 0.000 ms | 66,904,865 |
| Transcript virtualization / Task 9 | 0.581 ms | 65.239 ms | 1,844.725 ms | 0.000 ms | 66,904,865 |
| Sidebar virtualization / Task 10 | 0.585 ms | 65.928 ms | 1,862.215 ms | 0.000 ms | 66,904,865 |
| Instrumented final / Task 11 | 0.591 ms | 66.122 ms | 1,844.345 ms | 0.000 ms | 66,904,865 |

The material benchmark change is delivery lookup: 1,750.740 ms in the harness baseline to below the timer’s 0.001 ms reporting resolution after the parsed index. Later slices intentionally target IPC shape, persistence, delivery correctness, and DOM bounds rather than these four synchronous kernels.

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
| `pnpm --dir app/desktop bench:chat-scale` | Pass; all benchmark ceilings met |
| Focused chat reliability suite | Pass, 88/88 |
| `pnpm --dir app/desktop typecheck` | Pass |
| `pnpm --dir app/desktop lint` | Pass |
| `pnpm --dir app/desktop build` | Pass; bundle budget passes |
| `pnpm test:scripts` | Pass, 18/18 |
| `pnpm check:hygiene` | Pass |
| `git diff --check` | Pass before documentation update |
| Native canonical catalog/page regression | Pass; 20,000-row seed and byte limits |
| Desktop Rust suite | 253/255 in parallel; the two Cloud file-store tests pass 2/2 when serialized |
| `pnpm check:frontend` | Blocked by the same 19 pre-existing desktop test failures present on the reviewed base |
| `pnpm check:rust:fmt` | Blocked by repository-wide formatting drift, including files outside this stack |
| `pnpm check:rust:clippy` | Blocked by two pre-existing `SessionRow` test initializers missing `parent_session_message_id` in `agent/crates/tui/src/session_selector.rs` |
| `pnpm check:rust:test` | Core stages pass; desktop stage hits the two parallel Cloud file-store races described above |

The production bundle passed with six JavaScript chunks. The largest was `cloud-features` at 581.04 kB, within the repository’s configured budget.

The 19 frontend failures are baseline snapshot/source-contract mismatches in unrelated Cloud avatar/auth copy, viewport source assertions, shared-agent naming, and participant-context expectations. Final commit verification ran 1,132 tests: 1,113 passed and the same 19 baseline tests failed.

## Native acceptance matrix

The following scenarios were not run in this non-interactive worktree session. They need a packaged native build, seeded accounts, WebKit process observation, and—in the send cases—a real Postgres-backed Cloud server. An unrun test is not treated as a pass.

| Scenario | Automated proxy now available | Native status |
|---|---|---|
| Cold login with stale v1 cache | v1→v2 cache migration and catalog/page tests | Pending |
| Warm relaunch from v2 cache | async cache/store tests | Pending |
| Reactivation after five minutes | sync coordinator focus/pageshow tests | Pending |
| 50 switches between 1,000-message group and short direct chat | session paging and virtual transcript tests | Pending CPU/RSS capture |
| Scroll newest→oldest→newest | variable-height prepend/jump tests | Pending native visual run |
| Send to 20 recipients with one transient failure | durable outbox partial-success/retry tests | Pending real Cloud run |
| Restart before retry | durable persistence restore test | Pending packaged restart run |
| Open visible image previews without startup content hydration | metadata-only/lazy attachment tests | Pending network trace |

`bridges/cloud-server/tests/cloud_auth_e2e.rs` contains real-Postgres idempotency cases, but those tests return early when `DATABASE_URL` is absent. No database was configured for this capture, so those cases are not claimed as executed evidence.

## Product budget status

| Product budget | Evidence | Status |
|---|---|---|
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
| No synchronous history localStorage writes after migration | async v2 cache tests/source guard | Pass (automated) |

## Issue closure rules

- **#634:** do not close until the 20-recipient native send and real-Postgres idempotent partial-retry run pass.
- **#638:** do not close until native click/send p95s pass, logs contain no `database is locked`, and the IPC trace confirms no full-state click request.
- **#655:** do not close until cold, warm, and reactivation runs show neither stale unread flashes nor an empty selected shell.
- **#646:** do not close until the packaged variable-height open/scroll/prepend/jump matrix shows no blank viewport.
- **#633:** close last, only after all latency, payload, DOM, CPU, and RSS gates pass.

No issue was closed and no external state was changed while producing this report.
