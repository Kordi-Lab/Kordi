# Mixed image collections and unread image retrieval

Issue #417 follow-up, November 1, 2026. Related media coverage: #1512 and #1519.

## Changes

The desktop transcript places inline image previews outside the caption bubble even when the same send includes files. It retains the original message object, sender, attachment order within each collection, receipt, transfer controls, and preview gallery. Files and the caption remain in one bubble. Images that cannot be previewed inline remain downloadable file chips.

The Cloud runner previously returned provider-shaped `source.type=base64` images directly to OMP. OMP expects `data` and `mimeType` on the image block. Without conversion, a deterministic real-worker test captures no image blocks in the next provider request. The adapter now converts image blocks and preserves tool failures as errors.

Authorized history retrieval itself already reads current server state. The new database regression verifies that a newer image received after an initial index read is returned by subsequent reads. No speculative history or read-cursor behavior change is included.

## Automated evidence

All fixtures are synthetic; no account history, screenshots, credentials, or production services are used.

| Boundary | Evidence |
| --- | --- |
| Desktop composition | Own and peer messages, one/two images, two files, with/without caption: images are outside the bubble, sender/files/caption are retained, one outgoing receipt remains, and image/file order is preserved. All eight placement cases fail against the original component. |
| Desktop interactions | Expanding/collapsing a mixed send preserves its file chip; selecting the second image opens the existing media window with both sibling images and the correct selected index. Existing preview, attachment action, and transfer tests also run. |
| Authorized retrieval | Disposable PostgreSQL and loopback object storage exercise the owner member route and leased desktop run route. A mixed send retains ordered attachment references, then a newer image-only message becomes the latest result. Each image read returns the exact PNG bytes bound to the correct message. |
| Read state and access | Agent reads leave the human read cursor unchanged. Existing tests exercise cloud-runner retrieval, cross-scope denial, hidden/deleted media, source version changes, expired leases, and revoked access during download. |
| Cloud adapter | Real `read_session` execution returns flat typed images and does not copy image bytes into text metadata. Failed retrieval remains a failed tool result. |
| Provider input | Bun 1.4.2 / OMP 18.12.6 runs against a loopback synthetic Chat Completions provider. Two images from one message, followed by a newer third image, reach the next requests as exact image data URLs in order. Retrieved private media is not eligible for replay. Removing the conversion reproduces the missing image blocks. |

The three 64-by-64 PNG fixtures contain different color/shape information. Their neutral attachment IDs and captions do not describe that information. Byte comparisons establish transport preservation; the scripted provider response does **not** establish model comprehension.

## Reproduction

Run focused desktop tests from `app/desktop` with `node --import tsx --test`, selecting `transcriptImageAlignment.test.tsx`, `transcriptMixedAttachments.test.tsx`, `transcriptImageGroups.test.tsx`, `transcriptAttachments.test.tsx`, `transcriptAttachmentLightbox.test.tsx`, and `transcriptMessageTransferActions.test.tsx` in `tests/`.

Run `cargo test -p kordi-cloud-agent-runner --locked -- --test-threads=1`. The existing suite requires serial execution because some tests change process environment variables.

After installing the pinned dependencies in `shared/omp-runtime`, set `KORDI_OMP_WORKER_SCRIPT` to that checkout's `shared/omp-runtime/src/worker.ts` and run `cargo test -p kordi-cloud-agent-runner real_bun_cloud_ -- --ignored`. This is also included in `pnpm check:server`.

Point `DATABASE_URL` only at a disposable task-owned PostgreSQL database and run `cargo test -p kordi-cloud-server --test cloud_agent_runtime_e2e context_media -- --test-threads=1`. These database tests skip when `DATABASE_URL` is absent; a skipped run is not retrieval evidence.

## Remaining acceptance

The parent testing session must verify the complete current application page and sender/recipient actions in its existing clients, then run Luna with Low reasoning on newly received unread synthetic images. Require answers grounded in image-only information, repeat for mixed attachments and a newer image, and inspect provider input separately from read receipts. The automated transport tests above do not establish live model comprehension, deployed-client behavior, iOS UI validation, or production rollout; the native follow-up below records separate live evidence.

## November 3 native follow-up

Image collections now keep a sender avatar even when adjacent messages are from the same sender. The avatar aligns with the first image rather than the bottom of the caption/files bubble. This covers own, peer, and agent collections; peer avatars retain the profile action. Six regression cases cover pure and mixed collections, adjacent same-sender messages, expansion, and peer profile navigation.

A fresh two-image-plus-file message was sent through the native test client. The filenames and caption did not disclose the images' printed codes, shape counts, colors, or positions. The recipient's personal agent, using Luna with Low reasoning, could not retrieve the group: the initial session lookup returned no results, and retries using only the group keyword and only the channel keyword also returned no matching sessions. The native tool output confirmed the discovery failure. Image retrieval and visual comprehension were therefore not reached by this history test; this is not a passing unread-image result. See #2194 for the separate discovery boundary.

The sender avatar was verified in the native mixed-attachment history. All 47 focused image/grouping tests, TypeScript checks, and the production frontend build with unchanged bundle limits passed. The Cloud runner adapter remains undeployed. After the native picker stalled, the operator explicitly authorized a direct-image control through the same test backend API using the existing synthetic recipient account and its verified Luna Low route. Both PNGs were attached to one personal-agent request. The model correctly read both pixel-only codes, all shape counts/colors, and their spatial arrangement: three yellow triangles above one green circle, and five blue squares beside an orange star. The response was also verified in the native recipient app. Credentials stayed in memory and were not copied or printed. This passes direct attachment comprehension; it does not pass group discovery, unread-history retrieval, or the undeployed OMP tool-image adapter.
