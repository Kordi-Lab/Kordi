# One-Shot Reply Jump Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make each transcript reply-jump request scroll and highlight exactly once while preserving off-page loading and allowing a later nonce to repeat the jump intentionally.

**Architecture:** `VirtualTranscript` owns one-shot request consumption because it knows when the requested row is mounted. It records the handled identity only when the animation-frame completion callback runs, while `ChatSessionPane` supplies a stable callback and `ChatsPage` click handlers only enqueue navigation requests.

**Tech Stack:** React 19, TypeScript 6, TanStack React Virtual, Node test runner through `tsx`, JSDOM, pnpm.

---

### Task 1: Add failing one-shot navigation regressions

**Files:**
- Modify: `app/desktop/tests/virtualTranscript.test.tsx`
- Modify: `app/desktop/tests/panelAgentSessionParity.test.ts`

- [ ] **Step 1: Let the virtual-transcript harness observe navigation completion**

Add the optional callback to the `transcript` helper props and forward it to the component:

```tsx
function transcript(props: {
  items: readonly Row[];
  sessionKey?: string;
  navigationRequest?: { id: string; nonce: number } | null;
  onNavigationReady?: (messageId: string) => void;
  hasOlder?: boolean;
  onLoadOlder?: () => Promise<void> | void;
}) {
  return (
    <VirtualTranscript
      items={props.items}
      sessionKey={props.sessionKey ?? 'session:one'}
      getItemKey={(item) => item.id}
      renderItem={(item) => (
        <div data-message-id={item.id} data-test-row-height={item.height}>{item.id}</div>
      )}
      scrollStyle={{ height: 600 }}
      navigationRequest={props.navigationRequest}
      findNavigationIndex={(item, id) => item.id === id}
      onNavigationReady={props.onNavigationReady}
      hasOlder={props.hasOlder}
      onLoadOlder={props.onLoadOlder}
    />
  );
}
```

- [ ] **Step 2: Add a regression for same-request rerenders and unrelated data updates**

Append this behavioral test to `virtualTranscript.test.tsx`:

```tsx
test('a handled navigation request stays one-shot across transcript rerenders', async () => {
  const readyIds: string[] = [];
  const initialItems = rows('m', 0, 20);
  const request = { id: 'm10', nonce: 1 };
  const view = await render(transcript({
    items: initialItems,
    navigationRequest: request,
    onNavigationReady: (id) => readyIds.push(id),
  }));

  assert.deepEqual(readyIds, ['m10']);

  await view.rerender(transcript({
    items: [...initialItems],
    navigationRequest: { ...request },
    onNavigationReady: (id) => readyIds.push(id),
  }));
  await view.rerender(transcript({
    items: [...initialItems, { id: 'm20', height: 75 }],
    navigationRequest: { ...request },
    onNavigationReady: (id) => readyIds.push(id),
  }));

  assert.deepEqual(readyIds, ['m10']);
});
```

- [ ] **Step 3: Add coverage for a new nonce**

Append this test:

```tsx
test('a new navigation nonce handles the same message exactly one more time', async () => {
  const readyIds: string[] = [];
  const items = rows('m', 0, 20);
  const view = await render(transcript({
    items,
    navigationRequest: { id: 'm10', nonce: 1 },
    onNavigationReady: (id) => readyIds.push(id),
  }));

  await view.rerender(transcript({
    items: [...items],
    navigationRequest: { id: 'm10', nonce: 2 },
    onNavigationReady: (id) => readyIds.push(id),
  }));
  await view.rerender(transcript({
    items: [...items],
    navigationRequest: { id: 'm10', nonce: 2 },
    onNavigationReady: (id) => readyIds.push(id),
  }));

  assert.deepEqual(readyIds, ['m10', 'm10']);
});
```

- [ ] **Step 4: Strengthen the off-page test so completion must remain one-shot**

Update `jump-to-message loads older pages until the target exists and then mounts it` to collect ready IDs, pass `onNavigationReady`, rerender the same harness once after loading, and assert exact completion:

```tsx
test('jump-to-message loads older pages until the target exists and then mounts it', async () => {
  let loadCount = 0;
  const readyIds: string[] = [];
  function Harness() {
    const [items, setItems] = React.useState(() => rows('m', 900, 100));
    const [hasOlder, setHasOlder] = React.useState(true);
    return transcript({
      items,
      navigationRequest: { id: 'm850', nonce: 1 },
      onNavigationReady: (id) => readyIds.push(id),
      hasOlder,
      onLoadOlder: async () => {
        loadCount += 1;
        setItems((current) => [...rows('m', 850, 50), ...current]);
        setHasOlder(false);
      },
    });
  }

  const view = await render(<Harness />);
  await flush();
  await view.rerender(<Harness />);

  assert.equal(loadCount, 1);
  assert.deepEqual(readyIds, ['m850']);
  assert.ok(view.host.querySelector('[data-message-id="m850"]'));
  assert.equal(view.host.querySelector('[data-transcript-older-loading="true"]'), null);
});
```

- [ ] **Step 5: Add main/companion instance isolation coverage**

Append this test:

```tsx
test('main and companion transcript requests remain independently one-shot', async () => {
  const mainReady: string[] = [];
  const companionReady: string[] = [];
  const mainItems = rows('main-', 0, 20);
  const companionItems = rows('companion-', 0, 20);
  const pair = () => (
    <>
      {transcript({
        items: [...mainItems],
        sessionKey: 'main-session',
        navigationRequest: { id: 'main-10', nonce: 1 },
        onNavigationReady: (id) => mainReady.push(id),
      })}
      {transcript({
        items: [...companionItems],
        sessionKey: 'companion-session',
        navigationRequest: { id: 'companion-10', nonce: 2 },
        onNavigationReady: (id) => companionReady.push(id),
      })}
    </>
  );
  const view = await render(pair());

  await view.rerender(pair());

  assert.deepEqual(mainReady, ['main-10']);
  assert.deepEqual(companionReady, ['companion-10']);
});
```

- [ ] **Step 6: Update the integration contract to require a stable named callback**

Replace the inline-callback assertion in `panelAgentSessionParity.test.ts` with:

```ts
assert.match(
  pane,
  /const handleNavigationReady = useCallback\([\s\S]*navigateToTranscriptMessage\(messageId, scrollRef\)[\s\S]*\[scrollRef\]\);/,
  'the shared pane should expose a stable mounted-target navigation callback',
);
assert.match(
  pane,
  /onNavigationReady=\{handleNavigationReady\}/,
  'the mounted target should retain highlighting and centered navigation',
);
```

- [ ] **Step 7: Run the regressions and verify RED**

Run:

```bash
pnpm --dir app/desktop exec tsx --test \
  tests/virtualTranscript.test.tsx \
  tests/transcriptJumpHighlight.test.tsx
```

Expected: the new one-shot tests fail because the callback is replayed for the same nonce.

Run:

```bash
pnpm --dir app/desktop exec tsx --test \
  tests/panelAgentSessionParity.test.ts
```

Expected: `virtualized chat transcripts load and mount off-page jump targets` fails because `ChatSessionPane` still passes an inline callback.

### Task 2: Consume navigation once and remove the duplicate path

**Files:**
- Modify: `app/desktop/src/features/chat/VirtualTranscript.tsx`
- Modify: `app/desktop/src/pages/ChatsPage.tsx`
- Test: `app/desktop/tests/virtualTranscript.test.tsx`
- Test: `app/desktop/tests/panelAgentSessionParity.test.ts`

- [ ] **Step 1: Track the handled request identity in `VirtualTranscript`**

Add this ref beside the existing lifecycle refs:

```tsx
const handledNavigationRequestRef = useRef<string | null>(null);
```

Replace the navigation layout effect with:

```tsx
useLayoutEffect(() => {
  const request = navigationRequest;
  if (!request || navigationTargetIndex < 0) return undefined;
  const requestIdentity = JSON.stringify([sessionKey, request.nonce, request.id.trim()]);
  if (handledNavigationRequestRef.current === requestIdentity) return undefined;
  virtualizer.scrollToIndex(navigationTargetIndex, { align: 'center' });
  const frameId = window.requestAnimationFrame(() => {
    handledNavigationRequestRef.current = requestIdentity;
    onNavigationReady?.(request.id);
  });
  return () => window.cancelAnimationFrame(frameId);
}, [navigationRequest, navigationTargetIndex, onNavigationReady, sessionKey, virtualizer]);
```

- [ ] **Step 2: Stabilize the mounted-target callback in `ChatSessionPane`**

Add this callback after the attributed transcript values are derived:

```tsx
const handleNavigationReady = useCallback((messageId: string) => {
  navigateToTranscriptMessage(messageId, scrollRef);
}, [scrollRef]);
```

Pass it into `VirtualTranscript`:

```tsx
onNavigationReady={handleNavigationReady}
```

- [ ] **Step 3: Remove immediate navigation from both request handlers**

Leave the main handler as:

```tsx
const handleNavigateToTranscriptMessage = useCallback((messageId: string, sourceMessage?: MessageSourceReference) => {
  const targetMessageId = sourceMessage
    ? resolveTranscriptMessageIdForSource(sourceMessage, attributedTranscriptMessages)
    : messageId;
  const resolvedMessageId = targetMessageId || messageId;
  transcriptNavigationNonceRef.current += 1;
  setMainTranscriptNavigationRequest({ id: resolvedMessageId, nonce: transcriptNavigationNonceRef.current });
}, [attributedTranscriptMessages]);
```

Leave the companion handler as:

```tsx
const handleNavigateToCompanionTranscriptMessage = useCallback((messageId: string, sourceMessage?: MessageSourceReference) => {
  const targetMessageId = sourceMessage
    ? resolveTranscriptMessageIdForSource(sourceMessage, companionTranscriptMessages)
    : messageId;
  const resolvedMessageId = targetMessageId || messageId;
  transcriptNavigationNonceRef.current += 1;
  setCompanionTranscriptNavigationRequest({ id: resolvedMessageId, nonce: transcriptNavigationNonceRef.current });
}, [companionTranscriptMessages]);
```

- [ ] **Step 4: Run the focused suites and verify GREEN**

Run:

```bash
pnpm --dir app/desktop exec tsx --test \
  tests/virtualTranscript.test.tsx \
  tests/transcriptJumpHighlight.test.tsx
```

Expected: all virtual-transcript and highlight tests pass.

Run:

```bash
pnpm --dir app/desktop exec tsx --test \
  tests/panelAgentSessionParity.test.ts
```

Expected: all panel parity tests pass.

- [ ] **Step 5: Inspect the implementation diff**

Run:

```bash
git diff --check
git diff -- app/desktop/src/features/chat/VirtualTranscript.tsx app/desktop/src/pages/ChatsPage.tsx app/desktop/tests/virtualTranscript.test.tsx app/desktop/tests/panelAgentSessionParity.test.ts
```

Expected: no whitespace errors; only the one-shot lifecycle, stable callback, duplicate-path removal, and regression coverage are present.

- [ ] **Step 6: Commit the fix**

```bash
git add app/desktop/src/features/chat/VirtualTranscript.tsx app/desktop/src/pages/ChatsPage.tsx app/desktop/tests/virtualTranscript.test.tsx app/desktop/tests/panelAgentSessionParity.test.ts
git commit -m "fix: consume transcript reply jumps once"
```

### Task 3: Verify the complete desktop change

**Files:**
- Verify: `app/desktop/src/features/chat/VirtualTranscript.tsx`
- Verify: `app/desktop/src/pages/ChatsPage.tsx`
- Verify: `app/desktop/tests/virtualTranscript.test.tsx`
- Verify: `app/desktop/tests/panelAgentSessionParity.test.ts`

- [ ] **Step 1: Run the complete desktop unit suite**

Run:

```bash
pnpm --dir app/desktop test:unit
```

Expected: all desktop unit tests pass with zero failures.

- [ ] **Step 2: Run desktop type checking**

Run:

```bash
pnpm --dir app/desktop typecheck
```

Expected: TypeScript exits successfully with no errors.

- [ ] **Step 3: Run desktop linting**

Run:

```bash
pnpm --dir app/desktop lint
```

Expected: ESLint exits successfully with no errors.

- [ ] **Step 4: Build the production web bundle**

Run:

```bash
pnpm --dir app/desktop build
```

Expected: Vite and the bundle-budget check both exit successfully.

- [ ] **Step 5: Verify branch scope and history**

Run:

```bash
git status --short --branch
git log --oneline --decorate origin/main..HEAD
git diff --stat origin/main...HEAD
git diff --check origin/main...HEAD
```

Expected: the worktree is clean; branch history contains the design, plan, and fix commits; the diff is limited to the approved documentation, implementation, and tests; no whitespace errors are reported.

### Task 4: Harden request ownership after pre-merge review

**Files:**
- Modify: `app/desktop/src/features/chat/VirtualTranscript.tsx`
- Modify: `app/desktop/src/pages/ChatsPage.tsx`
- Modify: `app/desktop/tests/virtualTranscript.test.tsx`
- Modify: `app/desktop/tests/panelAgentSessionParity.test.ts`

- [ ] **Step 1: Add failing remount and session-switch regressions**

Add behavioral coverage proving that:

- an acknowledged request does not replay after its transcript unmounts and remounts;
- a request from session A cannot highlight a colliding message ID in session B;
- a missing session-A target cannot trigger older-page loading in session B;
- returning to session A can still complete a pending request.

Run the focused suites and confirm these cases fail against the original PR head for the expected lifecycle reasons.

- [ ] **Step 2: Carry and enforce request ownership**

Add `sessionKey` to `VirtualTranscriptNavigationRequest`. Treat the request as active only when its source session matches the `sessionKey` rendered by `VirtualTranscript`. Use that scoped request for target discovery, older-page loading, request identity, scrolling, and completion.

- [ ] **Step 3: Acknowledge completion nonce-safely**

Add an `onNavigationHandled` callback to `VirtualTranscript`. Invoke it with the handled request after the mounted-target callback. In `ChatsPage`, use functional state updates that clear main or companion request state only when session key, nonce, and trimmed message ID all match the handled request.

- [ ] **Step 4: Re-run review and the complete verification gate**

Run the focused regressions, desktop unit suite, type checking, linting, production build, and bundle budget. Re-review the final base-to-head diff before merging.
