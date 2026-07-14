# One-Shot Reply Jump Navigation Design

## Summary

One click on a reply indicator in a Cloud group transcript must produce one centered jump and one brief highlight. The current virtual transcript keeps the click's navigation request in React state indefinitely. Later Cloud synchronization rerenders recreate the inline completion callback, rerun the navigation layout effect, and reapply the highlight for the same request.

This change will make a virtual-transcript navigation request one-shot by request identity, keep off-page loading behavior intact, remove the duplicate immediate navigation path, and apply the same lifecycle to the main and companion transcripts.

## Evidence and Root Cause

`ChatsPage` stores separate main and companion `TranscriptNavigationRequest` objects. Each click increments a shared nonce, stores `{ id, nonce }`, and also calls `navigateToTranscriptMessage(...)` immediately. The stored request is not cleared or acknowledged.

`ChatSessionPane` passes `onNavigationReady` to `VirtualTranscript` as an inline function. Its identity changes whenever the pane rerenders. `VirtualTranscript` has a navigation `useLayoutEffect` that depends on the persistent request, target index, callback, and virtualizer. Once the target is loaded, any later callback-identity or relevant virtualizer change schedules the same completion callback again.

The completion callback calls `navigateToTranscriptMessage(...)`, which adds `app-transcript-message-highlight` and removes it after 1,500 milliseconds. Cloud group synchronization produces frequent rerenders, so repeated callbacks continually restart the finite highlight and make it appear to flash indefinitely.

The navigation path was introduced with variable-height transcript virtualization in commit `53a135fce`. The existing focused suite passes 26 tests but does not assert that a request nonce is consumed exactly once across rerenders.

## Goals

1. One navigation request invokes its completion callback at most once after its target is mounted.
2. Rerenders with new item-array and callback identities cannot replay a handled request.
3. A new nonce can intentionally jump to and highlight the same message again.
4. A missing target continues loading older pages until it is found or no older pages remain.
5. Main and companion transcript instances handle requests independently.
6. Reply jumps use one navigation path rather than an immediate DOM attempt followed by virtualizer completion.
7. Existing virtualization, scroll anchoring, highlight styling, and reduced-motion behavior remain unchanged.

## Non-goals

- Changing the 1,500-millisecond highlight duration or its visual styling.
- Changing Cloud polling cadence or message synchronization.
- Replacing transcript virtualization.
- Introducing a general event queue for unrelated transcript actions.
- Refactoring message identity or reply attribution beyond the navigation lifecycle.

## Design

### 1. Request identity and consumption

`VirtualTranscript` will keep a ref containing the most recently handled navigation identity. The identity will combine:

- `sessionKey`;
- `navigationRequest.nonce`;
- the trimmed `navigationRequest.id`.

The session key prevents a request handled in one session scope from being treated as the same operation in another. The nonce distinguishes repeated intentional clicks on the same message.

The navigation layout effect will return without scrolling or invoking the callback when the current identity matches the handled identity.

### 2. Target discovery and older-page loading

Request consumption will not occur while `navigationTargetIndex` is negative. The existing older-page loading effect remains responsible for requesting earlier pages, keyed by the session, nonce, message ID, item count, and oldest item key.

When the requested target becomes available, the navigation layout effect will center it through the virtualizer and schedule the completion callback on the next animation frame. The handled identity will be recorded inside that frame immediately before invoking the callback. This timing ensures that:

- the target is present before the request is consumed;
- a cancelled frame does not silently consume a request;
- React effect cleanup and development-mode effect replay can reschedule a cancelled frame;
- after the callback runs, later rerenders ignore the same request.

If a newer nonce replaces the request before the frame runs, effect cleanup cancels the old frame and the newer request becomes the operation that completes.

### 3. Stable completion callback

`ChatSessionPane` will define a memoized navigation-ready callback with `useCallback`. It will call `navigateToTranscriptMessage(messageId, scrollRef)` after the virtualizer has mounted and centered the target.

The stable callback reduces unnecessary navigation-effect churn. It is defense in depth; the one-shot identity guard remains the correctness boundary because other dependencies may still change.

### 4. Single navigation path

The main and companion click handlers will continue resolving the correct message ID, incrementing the nonce, and storing their respective navigation requests. They will stop calling `navigateToTranscriptMessage(...)` immediately.

The resulting flow is:

1. A reply indicator click creates a new request.
2. `VirtualTranscript` finds the target or loads older pages.
3. The virtualizer centers and mounts the target.
4. The memoized completion callback applies the highlight once.
5. The handled identity prevents replay until a request with a new identity arrives.

Both main and companion panes use the shared `ChatSessionPane` and `VirtualTranscript` path, so they receive the same behavior without duplicated lifecycle code.

## Error and Edge-Case Handling

- If the target is absent and older pages are available, navigation remains pending and page loading continues under the existing deduplication rules.
- If the target remains absent after older pages are exhausted, no callback runs and no request is falsely marked handled.
- If a scheduled animation frame is cancelled, the request remains eligible for the next effect run.
- If transcript data changes after a request is handled, the same identity remains ignored.
- A new nonce for the same message is a distinct request and receives one new completion callback.
- Separate `VirtualTranscript` component instances keep independent handled-request refs, so main and companion panes cannot consume each other's requests.

## Testing

### Virtual transcript behavioral coverage

Extend `app/desktop/tests/virtualTranscript.test.tsx` so its harness accepts `onNavigationReady`, then add coverage proving:

- an initially mounted target invokes the callback exactly once;
- rerendering the same request with a new request object, item-array reference, and callback identity does not invoke it again;
- unrelated transcript data changes do not replay a handled request;
- a new nonce for the same message invokes exactly one additional callback;
- an off-page target loads older data and invokes the callback exactly once after mounting;
- two transcript instances with main and companion session keys handle their requests independently and do not replay them on rerender.

The first regression test must fail against current `origin/main` by observing multiple callback invocations for one nonce before production code is changed.

### Integration contract coverage

Update `app/desktop/tests/panelAgentSessionParity.test.ts` to assert that `ChatSessionPane` passes a stable named completion callback into `VirtualTranscript` while retaining centered navigation and highlight behavior.

Keep the existing highlight styling assertions in `app/desktop/tests/transcriptJumpHighlight.test.tsx` unchanged.

### Verification commands

Run the focused files in discovery-safe groups:

```bash
pnpm --dir app/desktop exec tsx --test \
  tests/virtualTranscript.test.tsx \
  tests/transcriptJumpHighlight.test.tsx

pnpm --dir app/desktop exec tsx --test \
  tests/panelAgentSessionParity.test.ts
```

Then run desktop type checking, the complete desktop unit suite, linting, and the production web build.

## Manual Acceptance

In a Cloud group while normal synchronization remains active:

1. Click a reply indicator once and confirm one centered jump and one highlight lasting no more than approximately 1.5 seconds.
2. Leave the transcript idle for at least 30 seconds and confirm the highlight does not return.
3. Click the same indicator again and confirm exactly one new highlight.
4. Repeat with a target outside the currently mounted virtual range.
5. Repeat in the companion transcript.
6. Confirm reduced-motion mode jumps without repeated flashing.
7. Confirm the transcript scroll does not shift surrounding page or detail-panel layout.

## Acceptance Criteria

- A request identity completes at most once per mounted transcript instance.
- Same-request rerenders cannot reapply the highlight.
- A new nonce can re-highlight the same message exactly once.
- Off-page targets still load and mount before completion.
- Main and companion navigation remain independent.
- Click handlers no longer invoke both immediate and virtualizer-ready navigation paths.
- Focused regression tests, the desktop unit suite, type checking, linting, and the web build pass.
