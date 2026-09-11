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
