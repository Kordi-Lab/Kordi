# Desktop renderer resource budgets

The native SQLite stores own durable chat history. The WebKit renderer keeps a
compatibility working set for active UI and legacy message projectors.

## Message retention

After group and self-agent recovery settle, both the React message state and its
imperative backing reference point to the compacted collection. There is no
separate full-history collection retained behind the compact view.
The group-recovery bootstrap cache retains conversation metadata only, so its
initial message payload can be reclaimed after replay finishes.

Disposable history has these limits:

| Budget | Limit |
| --- | --- |
| Recent rows per peer | 64 |
| Active-session compatibility tail per peer | 64 |
| Aggregate retained rows | 4,096 |
| Estimated retained payload | 16 MiB |

Required session heads, latest model routes, pending outgoing messages, and wire
updates for loaded canonical pages are correctness pins. They establish an
explicit floor if they alone exceed the aggregate budget. Eviction never deletes
durable messages or pending operations. Canonical transcript pages remain loaded
through the existing native cursor API.

Direct-person chats do not require canonical transcript rows. Their selected
conversation loads a 50-message page from complete local chat-sync history, with
the server's before-sequence cursor as a fallback for incomplete or gapped local
coverage. Older pages load on demand into an active-only overlay, which is
released when selecting another chat. This prevents a fresh profile from showing
only its startup conversation preview while keeping inactive history out of the
renderer backing store.

Payload accounting estimates strings, arrays, objects, and primitive values. It
does not claim to measure JavaScriptCore's exact heap representation. Estimates
are cached with weak keys so the accounting itself cannot retain evicted rows.

Native unread totals come from SQLite. Optimistic reads cover a known message
sequence, so an evicted row cannot clear an unread count and a later arrival is
not hidden by an older read operation. The browser-only client retains its
existing message-based unread projection.

Each account owns one reusable message index. Subsequent updates reuse unchanged
parsed envelopes; the new index does not retain the previous index object.

## Preview retention

Reusable attachment previews have both a 128-entry limit and a 32 MiB estimated
cost limit. Cost includes encoded Blob bytes and, when dimensions are known, one
decoded RGBA frame. Cached native files use supplied size metadata, or a 1 MiB
fallback when unavailable. Source dimensions can overestimate a thumbnail.

Active preview leases can outlive cache eviction. Their URLs remain valid until
the last consumer releases them. Oversized previews can be displayed but are not
kept as reusable cache entries. Clearing the cache also preserves active leases
until their last release. Video poster cancellation releases a result that
arrives after its consumer has unmounted.

This is a reusable-cache budget, not a hard process-memory cap: WebKit's decoded
image caches, animation frames, rendering surfaces, and active consumers have
additional costs.

## Reproducible retention check

Run from `app/desktop`:

```sh
node --expose-gc --import tsx scripts/benchmark-renderer-retention.tsx
```

The synthetic fixture starts with 20,000 messages across 20 peers, with 2 KiB of
text per message. Each cycle revisits all 20 chats and adds 100 messages per peer.
The harness exercises the actual React store and samples Node's JavaScript heap
after explicit garbage collection.

| Checkpoint | Previous backing rows | Bounded backing rows | Previous heap | Bounded heap |
| --- | ---: | ---: | ---: | ---: |
| After cycle 1 | 22,000 | 1,280 | 101.26 MiB | 54.01 MiB |
| After cycle 2 | 24,000 | 1,280 | 105.96 MiB | 54.05 MiB |
| After cycle 3 | 26,000 | 1,280 | 110.66 MiB | 54.21 MiB |

The empty harness uses approximately 50 MiB. Values vary by runtime and machine;
the key regression checks are bounded retained rows and a stable heap trend.
These measurements are not installed-app WebKit footprint measurements.

Installed-release validation should repeat chat switches, history paging, media
viewing, edits to older loaded messages, and incoming messages while hidden.
Compare heap snapshots after returning to the same screen, and verify unread
counts and pending sends before drawing conclusions about memory leaks.

## History scrolling

While reading history, size corrections apply only to rows completely above the
viewport. The first visible row keeps its offset even when it is partially
visible or its media loads later. Changes inside or below the visible area can
relayout following content without scrolling the reader. Following the latest
message retains its separate bottom-alignment policy.

The virtualizer owns the message-key anchor used when an older page is prepended.
Upward wheel input cancels tail following before the native scroll event arrives.
Normal scrolling keeps native wheel behavior; no whole-list transition is added
for history insertion.

Older pages are requested within two viewport heights of the top, with the
existing single-flight and repeated-request guards. Initial alignment to the
latest message does not trigger history backfill. An upward wheel can still
request a page when the current transcript is too short to scroll.

Initial row estimates account for text wrapping, wide glyphs, line breaks,
attachment dimensions, collapsed media groups, and time separators. These are
bounded-cost estimates, not replacements for actual measured geometry.

Regression tests cover continued scrolling during page loading, variable-height
prepends, delayed media measurement above and inside the viewport, partial-row
anchors, early prefetch, short-page wheel input, and tail-follow cancellation.
The isolated 74-to-300-pixel visible-row resize previously moved scrollTop from
1,000 to 1,226; it now remains at 1,000. Above-viewport growth still applies the
necessary compensation to preserve the reading anchor.


### History ordering and reading-position regression coverage

Interactive canonical history uses a bounded display-order page and a composite
`createdAtMs / sequenceNum / id` cursor. Synchronization, unread accounting, and
background recovery retain their existing sequence semantics. This keeps old
membership notices, whose local insertion sequence may be newer than their event
time, out of newer transcript pages. The composite cursor also handles tied
sequences and deletion of a pagination boundary row without skipping history.
Catalog refreshes must not inject notices older than the loaded display window.

Time separators compare adjacent timestamped messages. Prepending history may
change the old first separator, but must not re-phase later separators. A reading
anchor preserves the content offset when its date badge changes; above-viewport
row resizing remains the virtualizer's responsibility. Exact measured/estimated
height matches are cached too, so changing metadata cannot silently replace a
previously displayed row's height estimate.

Regression coverage includes synthetic late-replayed membership events, tied
cursors, deleted boundary rows, legacy encoded group messages, and continuous
scrolling through variable-height prepends. Run the isolated real-browser fixture
with `pnpm --dir app/desktop exec playwright test -c playwright.history.config.ts`.
Set `KORDI_HISTORY_TEST_PORT` to an unused loopback port for concurrent tasks.
The WebKit and Chromium cases require less than one CSS pixel of final content
anchor drift after two pages and delayed media growth. They use generated text
and no account data; they do not replace testing a long-running native session.

### Development timing history versus production memory

React development Performance tracks write User Timing measures with serialized
component-prop details. Clearing Kordi's own bounded diagnostic records does not
clear those framework entries. Long-running development sessions therefore need
a separate observer that releases React component/scheduler measures after
observers consume them. Other application measures remain available. Set
`VITE_KORDI_RETAIN_REACT_PERFORMANCE_HISTORY=1` only when deliberately retaining
that history for profiling; normal production React builds do not emit it.

The named-profile launcher accepts `--frontend production` to build and serve
the production frontend instead of the Vite development server. Use this option
for product memory measurements through the approved environment launcher. It
preserves the selected account-storage profile, API guards, title, and disabled
updater. The native binary is still a debug build, so label it as a production
frontend preview rather than a release application. The generated command builds
before serving; rebuild/relaunch to test subsequent source changes.

Run `pnpm --dir app/desktop exec playwright test -c playwright.memory.config.ts`
for real WebKit/Chromium coverage of timing-history cleanup, including preexisting
entries and preservation of application diagnostics. Use
`KORDI_HISTORY_TEST_PORT` to choose an unused local port. Compare both allocated
objects and physical footprint: cleared timing records can become collectible
before WebKit returns allocator pages to the OS, and a restarted production
frontend is not an equal-uptime comparison with a long-lived development session.
