# Group Session Switching and Cloud Replay Stability Design

## Summary

Users must be able to switch directly between child sessions inside one group. In the reproduced `user1` profile, clicking the second child session leaves the first row highlighted while the sidebar can visibly flicker. The sidebar click handler and stored session identifiers are correct; background state paths can starve the foreground selection update, while a separate native WebKit tooltip interaction destabilizes child-row hover.

This change will bound and serialize Cloud group replay, restore React's functional-setter no-op contract in the canonical-store adapter, and add a behavioral regression proving that two sessions in the same group remain independently selectable.

## Evidence and Root Cause

The live profile contains two distinct group sessions:

- `session:group:e91d7fc0-772e-4ea6-999c-d2072159e6d2`
- `session:group:c392fad1-b59a-4c0c-a7dc-32bc0ef7e8fd`

Both intentionally share the same `groupSpaceId`, but their session IDs and message histories are independent. `WorkspaceSidebar` passes the clicked child row's `session.id` to `onSelectChatSession`, and `useDesktopSessionController` immediately calls `setActiveConvId(sessionId)`. There is no identifier collapse in this path.

The live renderer log repeatedly reports:

- `Maximum update depth exceeded`
- `[cloud-group] sync failed`

The current replay effect walks every replay row, starts each `applyCloudGroupControl` call without awaiting the previous row, and removes the replay key from the processed set whenever a row fails. A subsequent Cloud-index or callback dependency change can therefore retry the same failing row immediately. Each replay also performs canonical writes and React state updates. Historical processing controls in the reproduced profile make this an enduring retry and render loop rather than a one-time startup burst.

Live stack tracing after the replay fix exposed a second loop in Cloud unread reconciliation. That effect correctly returns its current canonical state when unread counts are already equal, but `setCanonicalSessionState` always merged the result into a new `CanonicalStore`. The changed store identity recreated `canonicalSessionState`, retriggered the effect, and produced `Maximum update depth exceeded` continuously even though the logical state was unchanged.

The state loops prevent the active-session update from committing reliably. After those loops were removed, a real `mousemove` reproduction exposed two hover-specific problems. First, the `title` attribute on the truncated child-session label opens WebKit's native tooltip over the next row. More importantly, `ParticipantSpaceSessionRow` is declared inside `WorkspaceSidebar`, so every sidebar refresh creates a new React component type. Live mount diagnostics showed both group child buttons unmounting and remounting several times per second. Each remount drops `:hover`, which produces the continuing blue flicker even after the tooltip is removed.

## Goals

1. Clicking any visible child session immediately selects that exact session ID.
2. Cloud group replay performs a bounded number of canonical mutations per replay generation.
3. A failed replay row cannot retry on every render or dependency change.
4. Successful replay remains idempotent and eventually processes new Cloud controls.
5. Existing Cloud group delivery, agent-response, unread, and session hydration behavior remains intact.
6. A functional canonical state update that returns its current value must not rebuild or redispatch the store.
7. Group child rows must not use a native title tooltip that can interrupt WebKit hover hit testing.
8. Structurally unchanged group child buttons must preserve their DOM identity across sidebar refreshes.

## Non-goals

- Changing the group/session visual design.
- Introducing a second optimistic selection state solely for the sidebar.
- Dropping or permanently ignoring valid Cloud group controls.
- Refactoring unrelated Cloud synchronization or canonical storage code.

## Design

### 1. Replay coordinator

Add a small replay coordinator outside React. It will own replay lifecycle state for one account:

- completed replay keys;
- the currently draining promise;
- retry metadata for failed keys;
- the latest requested replay snapshot;
- an account generation used to invalidate work after account changes.

The coordinator accepts an ordered list of replay rows and an asynchronous row handler. It drains rows serially. Serial execution avoids concurrent SQLite writes and prevents many replay completions from committing React state in the same frame.

Only one drain may run at a time. If a newer Cloud index arrives while a drain is active, the coordinator records the newer snapshot and performs another bounded pass after the current pass finishes.

### 2. Retry policy

A successful replay key is retained for the lifetime of the account generation. A failed key records its retry count and next eligible time instead of being deleted immediately.

Retries use exponential cooldown beginning at one second and capped at thirty seconds. New Cloud sync results or the existing periodic Cloud refresh may request another drain, but the coordinator skips failed rows until their cooldown expires. The coordinator does not create a render-loop timer; React renders alone cannot trigger an immediate retry.

Changing accounts resets completed and failed replay state and invalidates any in-flight generation.

### 3. Hook integration

`useCloudBridgeState` will create one coordinator instance and reset it when the account ID changes. The Cloud group replay effect will submit `cloudMessageIndex.replayRows` to the coordinator instead of launching uncoordinated `void applyCloudGroupControl(...)` calls.

The row handler remains `applyCloudGroupControl`, preserving the existing compact canonical write path. Because rows are serialized and retry eligibility is external to React, the existing handler can continue to update canonical state after each completed row without producing an unbounded synchronous burst.

The coordinator will expose an optional failure callback for the existing warning log. The log will contain the retry count and cooldown but no message contents or account secrets.

### 4. Session selection

Child-session selection remains a foreground UI action:

1. The row calls `onSelectChatSession(session.id)`.
2. The session controller sets `activeConvId` immediately.
3. `activeSidebarRowSessionId` resolves the exact child row.
4. The active conversation read model selects the conversation with that ID.

No network request or replay drain is awaited by this path. The fix removes the background state storm that currently prevents this flow from committing. We will not add a separate sidebar-only active ID because that could display a new highlight while leaving the transcript on the old conversation.

### 5. Canonical state no-op identity

The canonical-store adapter will evaluate a functional `setCanonicalSessionState` action once against the current derived state. If the action returns that same state object, the adapter returns the current `CanonicalStore` object. The store dispatcher also skips identity-equal updates.

This matches React's native functional setter contract and prevents derived reconciliation effects, including unread-count reconciliation, from turning logical no-ops into render loops.

### 6. Stable group child hover

The visible child-session title remains normal text inside the button, so the button keeps its complete accessible name together with preview and timestamp content. The nested title span will not set an HTML `title` attribute. This prevents Tauri/WebKit from creating a native tooltip above the next row and repeatedly interrupting the hover state.

### 7. Stable group child host identity

Group child rows will use the same direct render-function pattern as agent session rows. `WorkspaceSidebar` may recompute row content when Cloud polling refreshes conversation objects, but React will continue reconciling the same host `<button>` rather than receiving a newly created nested component type. Stable session keys and stable host element types preserve the existing DOM node and its CSS hover state.

## Error Handling

- A replay failure is isolated to its replay key and does not abort later eligible rows.
- Failed rows retain retry metadata and retry after cooldown.
- Account changes invalidate stale work so one account cannot update another account's state.
- A handler rejection is logged once per attempt, not once per render.
- Coordinator callbacks check the current generation before starting another pass.

## Testing

### Coordinator unit tests

- Rows drain in order with at most one handler call in flight.
- Duplicate replay keys run once after success.
- A failed key is not immediately retried when the same snapshot is requested again.
- A failed key becomes eligible after the cooldown.
- A newer snapshot submitted during a drain is processed afterward.
- Resetting the account generation invalidates stale queued work.

### Sidebar behavioral regression

Use the existing JSDOM/React harness pattern to render a group containing two sessions with the same `groupSpaceId`. Click the second child row and assert:

- `onSelectChatSession` receives the second session's exact ID;
- the controlled harness rerenders with the second ID;
- only the second row has `app-session-row-active`;
- the selected conversation corresponds to the second session.

### Canonical adapter regression

Apply a functional canonical-session update that returns its current value and assert that the adapter returns the exact existing store object.

### Hover tooltip regression

Render an expanded group child row and assert that its visible hashtag title remains present but the nested title span has no native `title` attribute.

### Host identity regression

Assert that `WorkspaceSidebar` renders participant-space child rows through a direct render function and does not declare an inline `ParticipantSpaceSessionRow` component type. Live diagnostics must show no recurring child mount/unmount cycle after the change.

### Existing suites

Run the focused Cloud replay, participant-space sidebar, virtual sidebar, routing, and performance tests, followed by desktop type checking and the complete desktop unit suite.

### Live verification

Relaunch the preserved `user1` profile and verify:

1. The renderer log does not emit `Maximum update depth exceeded` during startup or after entering chat.
2. Clicking `# main` moves the blue highlight from `# hiiiii` to `# main`.
3. The right transcript changes to the older session with its 139-message history.
4. Clicking back selects the newer two-message session.
5. Holding the pointer over either child row leaves the row pixels stable without blue-highlight flicker.

## Acceptance Criteria

- Two or more sessions inside one group can be switched by clicking their child rows.
- The active highlight and transcript always represent the same session ID.
- Failed Cloud group replay does not cause a render-driven retry loop.
- Canonical state no-op updates preserve store identity and do not retrigger reconciliation effects.
- Child-session hover and active highlighting remain visually stable.
- Replay remains eventual and idempotent across Cloud refreshes.
- No existing Cloud group or sidebar regression tests fail.
