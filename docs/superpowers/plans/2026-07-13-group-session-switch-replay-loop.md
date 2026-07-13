# Group Session Switching and Cloud Replay Stability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent Cloud group replay from entering a React update loop so users can switch reliably between multiple child sessions in the same group.

**Architecture:** Add a framework-independent replay coordinator that serializes rows, remembers successes, and retries failures on bounded exponential cooldowns. Integrate one coordinator instance into `useCloudBridgeState`, then lock the foreground session-selection behavior with a JSDOM regression covering two sessions that share one group space.

**Tech Stack:** TypeScript, React 19 hooks, Node test runner, JSDOM, Tauri canonical-session IPC, pnpm/tsx.

---

## File Structure

- Create `app/desktop/src/features/cloud/cloudGroupReplayCoordinator.ts` — generic serialized replay lifecycle, success dedupe, account invalidation, and retry scheduling.
- Create `app/desktop/tests/cloudGroupReplayCoordinator.test.tsx` — deterministic coordinator concurrency, dedupe, cooldown, queued-snapshot, and account-reset tests.
- Modify `app/desktop/src/features/cloud/useCloudBridgeState.ts` — replace the render-coupled processed-key loop with the coordinator.
- Modify `app/desktop/tests/cloudBridgeState.test.tsx` — assert the hook is wired through the coordinator and no longer deletes failed keys for immediate retry.
- Modify `app/desktop/tests/virtualSidebar.test.tsx` — behavioral regression for clicking between two session rows in the same group space.
- Modify `app/desktop/src/features/canonical/canonicalStore.ts` — preserve store identity when a functional canonical state update is a no-op.
- Modify `app/desktop/src/app/useKordiAppModel.ts` — use the canonical action adapter and skip identity-equal store dispatches.
- Modify `app/desktop/tests/canonicalCatalog.test.tsx` — regression for the functional no-op contract.
- Modify `app/desktop/src/pages/WorkspaceSidebar.tsx` — remove the native WebKit tooltip trigger from group child titles.
- Modify `app/desktop/tests/workspaceSidebarParticipantSpaces.test.tsx` — lock the stable-hover markup contract.

### Task 1: Build the Serialized Replay Coordinator

**Files:**
- Create: `app/desktop/tests/cloudGroupReplayCoordinator.test.tsx`
- Create: `app/desktop/src/features/cloud/cloudGroupReplayCoordinator.ts`

- [ ] **Step 1: Write the failing coordinator tests**

Create `app/desktop/tests/cloudGroupReplayCoordinator.test.tsx`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { CloudGroupReplayCoordinator } from '../src/features/cloud/cloudGroupReplayCoordinator';

type Row = { id: string };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => { resolve = next; });
  return { promise, resolve };
}

function flushMicrotasks() {
  return new Promise<void>((resolve) => queueMicrotask(resolve));
}

test('CloudGroupReplayCoordinator drains rows serially and deduplicates successes', async () => {
  const gate = deferred();
  const started: string[] = [];
  const completed: string[] = [];
  let inFlight = 0;
  let peakInFlight = 0;
  const coordinator = new CloudGroupReplayCoordinator<Row>();
  coordinator.changeAccount('acct:one');

  const firstDrain = coordinator.request({
    entries: [
      { key: 'one', row: { id: 'one' } },
      { key: 'two', row: { id: 'two' } },
    ],
    apply: async (row) => {
      started.push(row.id);
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      if (row.id === 'one') await gate.promise;
      completed.push(row.id);
      inFlight -= 1;
    },
  });

  await flushMicrotasks();
  assert.deepEqual(started, ['one']);
  gate.resolve();
  await firstDrain;
  assert.deepEqual(completed, ['one', 'two']);
  assert.equal(peakInFlight, 1);

  await coordinator.request({
    entries: [
      { key: 'one', row: { id: 'one' } },
      { key: 'two', row: { id: 'two' } },
    ],
    apply: async (row) => { started.push(`duplicate:${row.id}`); },
  });
  assert.deepEqual(started, ['one', 'two']);
  coordinator.dispose();
});

test('CloudGroupReplayCoordinator backs off failures and retries after cooldown', async () => {
  let nowMs = 10_000;
  let scheduled: (() => void) | null = null;
  const delays: number[] = [];
  const attempts: number[] = [];
  const failures: Array<{ attempt: number; retryDelayMs: number }> = [];
  const coordinator = new CloudGroupReplayCoordinator<Row>({
    now: () => nowMs,
    setTimer: (callback, delayMs) => {
      scheduled = callback;
      delays.push(delayMs);
      return delays.length;
    },
    clearTimer: () => { scheduled = null; },
  });
  coordinator.changeAccount('acct:one');

  const request = () => coordinator.request({
    entries: [{ key: 'broken', row: { id: 'broken' } }],
    apply: async () => {
      attempts.push(nowMs);
      throw new Error('expected failure');
    },
    onFailure: ({ attempt, retryDelayMs }) => failures.push({ attempt, retryDelayMs }),
  });

  await request();
  assert.deepEqual(attempts, [10_000]);
  assert.deepEqual(failures, [{ attempt: 1, retryDelayMs: 1_000 }]);
  assert.deepEqual(delays, [1_000]);

  await request();
  assert.deepEqual(attempts, [10_000], 'a render-time repeat must not bypass cooldown');

  nowMs = 11_000;
  const retry = scheduled;
  assert.ok(retry);
  retry();
  await flushMicrotasks();
  await flushMicrotasks();
  assert.deepEqual(attempts, [10_000, 11_000]);
  assert.deepEqual(failures, [
    { attempt: 1, retryDelayMs: 1_000 },
    { attempt: 2, retryDelayMs: 2_000 },
  ]);
  coordinator.dispose();
});

test('CloudGroupReplayCoordinator consumes a newer snapshot after the active drain', async () => {
  const gate = deferred();
  const applied: string[] = [];
  const coordinator = new CloudGroupReplayCoordinator<Row>();
  coordinator.changeAccount('acct:one');

  const active = coordinator.request({
    entries: [{ key: 'one', row: { id: 'one' } }],
    apply: async (row) => {
      applied.push(row.id);
      await gate.promise;
    },
  });
  await flushMicrotasks();
  const queued = coordinator.request({
    entries: [
      { key: 'one', row: { id: 'one' } },
      { key: 'two', row: { id: 'two' } },
    ],
    apply: async (row) => { applied.push(row.id); },
  });
  gate.resolve();
  await Promise.all([active, queued]);
  assert.deepEqual(applied, ['one', 'two']);
  coordinator.dispose();
});

test('CloudGroupReplayCoordinator invalidates queued rows when the account changes', async () => {
  const gate = deferred();
  const applied: string[] = [];
  const coordinator = new CloudGroupReplayCoordinator<Row>();
  coordinator.changeAccount('acct:one');

  const oldDrain = coordinator.request({
    entries: [
      { key: 'old-one', row: { id: 'old-one' } },
      { key: 'old-two', row: { id: 'old-two' } },
    ],
    apply: async (row) => {
      applied.push(row.id);
      if (row.id === 'old-one') await gate.promise;
    },
  });
  await flushMicrotasks();
  coordinator.changeAccount('acct:two');
  const newDrain = coordinator.request({
    entries: [{ key: 'new-one', row: { id: 'new-one' } }],
    apply: async (row) => { applied.push(row.id); },
  });
  gate.resolve();
  await Promise.all([oldDrain, newDrain]);
  assert.deepEqual(applied, ['old-one', 'new-one']);
  coordinator.dispose();
});
```

- [ ] **Step 2: Run the coordinator test and confirm RED**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/cloudGroupReplayCoordinator.test.tsx
```

Expected: FAIL because `../src/features/cloud/cloudGroupReplayCoordinator` does not exist.

- [ ] **Step 3: Implement the minimal coordinator**

Create `app/desktop/src/features/cloud/cloudGroupReplayCoordinator.ts`:

```ts
export type CloudGroupReplayEntry<Row> = {
  key: string;
  row: Row;
};

export type CloudGroupReplayFailure = {
  key: string;
  attempt: number;
  retryDelayMs: number;
  error: unknown;
};

export type CloudGroupReplayRequest<Row> = {
  entries: readonly CloudGroupReplayEntry<Row>[];
  apply: (row: Row) => Promise<void>;
  onFailure?: (failure: CloudGroupReplayFailure) => void;
};

type RetryState = {
  attempt: number;
  nextEligibleAtMs: number;
};

type QueuedRequest<Row> = CloudGroupReplayRequest<Row> & {
  generation: number;
};

type TimerHandle = ReturnType<typeof setTimeout>;

type CloudGroupReplayCoordinatorOptions = {
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle | number;
  clearTimer?: (handle: TimerHandle | number) => void;
  baseRetryMs?: number;
  maxRetryMs?: number;
};

export class CloudGroupReplayCoordinator<Row> {
  private readonly now: () => number;
  private readonly setTimer: NonNullable<CloudGroupReplayCoordinatorOptions['setTimer']>;
  private readonly clearTimer: NonNullable<CloudGroupReplayCoordinatorOptions['clearTimer']>;
  private readonly baseRetryMs: number;
  private readonly maxRetryMs: number;
  private accountKey: string | null = null;
  private generation = 0;
  private completedKeys = new Set<string>();
  private retryByKey = new Map<string, RetryState>();
  private pendingRequest: QueuedRequest<Row> | null = null;
  private latestRequest: CloudGroupReplayRequest<Row> | null = null;
  private drainPromise: Promise<void> | null = null;
  private retryTimer: TimerHandle | number | null = null;
  private retryTimerAtMs: number | null = null;

  constructor(options: CloudGroupReplayCoordinatorOptions = {}) {
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as TimerHandle));
    this.baseRetryMs = options.baseRetryMs ?? 1_000;
    this.maxRetryMs = options.maxRetryMs ?? 30_000;
  }

  changeAccount(accountKey: string | null) {
    if (this.accountKey === accountKey) return;
    this.accountKey = accountKey;
    this.generation += 1;
    this.completedKeys.clear();
    this.retryByKey.clear();
    this.pendingRequest = null;
    this.latestRequest = null;
    this.clearRetryTimer();
  }

  request(request: CloudGroupReplayRequest<Row>): Promise<void> {
    this.latestRequest = request;
    this.pendingRequest = { ...request, generation: this.generation };
    if (!this.drainPromise) this.startDrain();
    return this.drainPromise ?? Promise.resolve();
  }

  dispose() {
    this.accountKey = null;
    this.generation += 1;
    this.completedKeys.clear();
    this.retryByKey.clear();
    this.pendingRequest = null;
    this.latestRequest = null;
    this.clearRetryTimer();
  }

  private startDrain() {
    const running = this.drain().finally(() => {
      if (this.drainPromise === running) this.drainPromise = null;
      if (this.pendingRequest) this.startDrain();
      else this.scheduleRetry();
    });
    this.drainPromise = running;
  }

  private async drain() {
    while (this.pendingRequest) {
      const request = this.pendingRequest;
      this.pendingRequest = null;
      if (request.generation !== this.generation) continue;

      for (const entry of request.entries) {
        if (request.generation !== this.generation) break;
        if (this.completedKeys.has(entry.key)) continue;
        const retry = this.retryByKey.get(entry.key);
        if (retry && retry.nextEligibleAtMs > this.now()) continue;

        try {
          await request.apply(entry.row);
          if (request.generation !== this.generation) break;
          this.completedKeys.add(entry.key);
          this.retryByKey.delete(entry.key);
        } catch (error) {
          if (request.generation !== this.generation) break;
          const attempt = (retry?.attempt ?? 0) + 1;
          const retryDelayMs = Math.min(
            this.maxRetryMs,
            this.baseRetryMs * (2 ** Math.min(attempt - 1, 30)),
          );
          this.retryByKey.set(entry.key, {
            attempt,
            nextEligibleAtMs: this.now() + retryDelayMs,
          });
          request.onFailure?.({ key: entry.key, attempt, retryDelayMs, error });
        }
      }
    }
  }

  private scheduleRetry() {
    const request = this.latestRequest;
    if (!request) return;
    const requestKeys = new Set(request.entries.map((entry) => entry.key));
    const nextRetryAtMs = [...this.retryByKey.entries()]
      .filter(([key]) => requestKeys.has(key) && !this.completedKeys.has(key))
      .reduce<number | null>((earliest, [, retry]) => (
        earliest === null ? retry.nextEligibleAtMs : Math.min(earliest, retry.nextEligibleAtMs)
      ), null);
    if (nextRetryAtMs === null) {
      this.clearRetryTimer();
      return;
    }
    if (this.retryTimer !== null && this.retryTimerAtMs !== null && this.retryTimerAtMs <= nextRetryAtMs) return;
    this.clearRetryTimer();
    this.retryTimerAtMs = nextRetryAtMs;
    this.retryTimer = this.setTimer(() => {
      this.retryTimer = null;
      this.retryTimerAtMs = null;
      const latest = this.latestRequest;
      if (latest) void this.request(latest);
    }, Math.max(0, nextRetryAtMs - this.now()));
  }

  private clearRetryTimer() {
    if (this.retryTimer !== null) this.clearTimer(this.retryTimer);
    this.retryTimer = null;
    this.retryTimerAtMs = null;
  }
}
```

- [ ] **Step 4: Run the coordinator tests and confirm GREEN**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/cloudGroupReplayCoordinator.test.tsx
```

Expected: 4 tests pass with zero failures.

- [ ] **Step 5: Commit the coordinator**

```bash
git add app/desktop/src/features/cloud/cloudGroupReplayCoordinator.ts app/desktop/tests/cloudGroupReplayCoordinator.test.tsx
git commit -m "fix: coordinate cloud group replay retries"
```

### Task 2: Route Cloud Group Replay Through the Coordinator

**Files:**
- Modify: `app/desktop/tests/cloudBridgeState.test.tsx`
- Modify: `app/desktop/src/features/cloud/useCloudBridgeState.ts:1-170`
- Modify: `app/desktop/src/features/cloud/useCloudBridgeState.ts:1984-2045`
- Modify: `app/desktop/src/features/cloud/useCloudBridgeState.ts:2098-2135`
- Modify: `app/desktop/src/features/cloud/useCloudBridgeState.ts:3792-3806`

- [ ] **Step 1: Write the failing hook-wiring regression**

In the existing `cloud bridge state loads the asynchronous cache without treating it as authoritative` test, replace the final assertion that expects `for (const row of cloudMessageIndex.replayRows)` with an assertion that the guarded effect calls `cloudGroupReplayCoordinator.request`.

Add this test after the existing asynchronous-cache source test in `app/desktop/tests/cloudBridgeState.test.tsx`:

```ts
test('cloud group control replay uses bounded coordinator retries', () => {
  const source = readFileSync(new URL('../src/features/cloud/useCloudBridgeState.ts', import.meta.url), 'utf8');
  const replayStart = source.indexOf('if (!account || !canonicalSessionState?.profile.humanIdentityId');
  const replayEnd = source.indexOf('\n  useEffect(() => {', replayStart + 1);
  assert.notEqual(replayStart, -1, 'expected Cloud group replay effect');
  assert.notEqual(replayEnd, -1, 'expected Cloud group replay effect end');
  const replayEffect = source.slice(replayStart, replayEnd);

  assert.match(source, /new CloudGroupReplayCoordinator<IndexedCloudGroupRow>/);
  assert.match(source, /cloudGroupReplayCoordinator\.changeAccount\(accountId\)/);
  assert.match(replayEffect, /cloudGroupReplayCoordinator\.request\(/);
  assert.match(replayEffect, /entries: cloudMessageIndex\.replayRows\.map/);
  assert.doesNotMatch(replayEffect, /processedCloudGroupControlIdsRef/);
  assert.doesNotMatch(replayEffect, /processedCloudGroupControlIdsRef\.current\.delete/);
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run:

```bash
pnpm --dir app/desktop exec tsx --test --test-name-pattern="bounded coordinator retries" tests/cloudBridgeState.test.tsx
```

Expected: FAIL because `useCloudBridgeState` has not instantiated or requested the coordinator.

- [ ] **Step 3: Import and instantiate the coordinator**

Add this import beside the other Cloud helper imports in `app/desktop/src/features/cloud/useCloudBridgeState.ts`:

```ts
import { CloudGroupReplayCoordinator } from './cloudGroupReplayCoordinator';
```

After the existing coordinator `useMemo` declarations near `cloudSyncCoordinator`, add:

```ts
  const cloudGroupReplayCoordinator = useMemo(
    () => new CloudGroupReplayCoordinator<IndexedCloudGroupRow>(),
    [],
  );
```

Remove this obsolete ref:

```ts
  const processedCloudGroupControlIdsRef = useRef<Set<string>>(new Set());
```

- [ ] **Step 4: Reset replay state with the account generation**

In the existing account-reset effect that begins with `cloudSyncCoordinator.changeAccount()`, add the coordinator reset immediately after computing `accountId`:

```ts
    const accountId = account?.accountId ?? null;
    cloudGroupReplayCoordinator.changeAccount(accountId);
```

Add `cloudGroupReplayCoordinator` to that effect's dependency array.

Add a one-time cleanup effect beside the coordinator refs:

```ts
  useEffect(() => () => {
    cloudGroupReplayCoordinator.dispose();
  }, [cloudGroupReplayCoordinator]);
```

- [ ] **Step 5: Replace the unbounded replay effect**

Replace the current `for (const row of cloudMessageIndex.replayRows)` block with:

```ts
  useEffect(() => {
    if (!account || !canonicalSessionState?.profile.humanIdentityId || !setCanonicalSessionState || !initialMessagesSettled) return;
    void cloudGroupReplayCoordinator.request({
      entries: cloudMessageIndex.replayRows.map((row) => ({
        key: cloudGroupReplayKeyForRow(row),
        row,
      })),
      apply: async (row) => {
        await applyCloudGroupControl(row.wire, row.envelope);
      },
      onFailure: ({ attempt, retryDelayMs, error }) => {
        // eslint-disable-next-line no-console
        console.warn('[cloud-group] sync failed; retry scheduled', { attempt, retryDelayMs }, error);
      },
    });
  }, [
    account,
    applyCloudGroupControl,
    canonicalSessionState?.profile.humanIdentityId,
    cloudGroupReplayCoordinator,
    cloudMessageIndex,
    initialMessagesSettled,
    setCanonicalSessionState,
  ]);
```

- [ ] **Step 6: Run focused Cloud tests and confirm GREEN**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/cloudGroupReplayCoordinator.test.tsx tests/cloudGroupReplayPerformance.test.ts tests/cloudBridgeState.test.tsx
```

Expected: all focused tests pass and the replay source regression finds no immediate processed-key deletion.

- [ ] **Step 7: Run type checking**

Run:

```bash
pnpm --dir app/desktop typecheck
```

Expected: exit code 0 with no TypeScript errors.

- [ ] **Step 8: Commit hook integration**

```bash
git add app/desktop/src/features/cloud/useCloudBridgeState.ts app/desktop/tests/cloudBridgeState.test.tsx
git commit -m "fix: bound cloud group replay state updates"
```

### Task 3: Lock Group Child-Session Selection Behavior

**Files:**
- Modify: `app/desktop/tests/virtualSidebar.test.tsx`

- [ ] **Step 1: Add the controlled two-session interaction regression**

Update the React import in `app/desktop/tests/virtualSidebar.test.tsx`:

```ts
import React, { act, useMemo, useState } from 'react';
```

Add this test after the existing flat-descriptor test:

```tsx
test('two sessions in one group space switch the active child row by exact id', async () => {
  const selectedIds: string[] = [];
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);

  function GroupSessionHarness() {
    const [activeSessionId, setActiveSessionId] = useState('session:group:new');
    const rows = useMemo(() => buildChatSidebarRows({
      spaces: [{
        spaceId: 'group:session:group:shared',
        expanded: true,
        rootSessionIds: ['session:group:new', 'session:group:old'],
      }],
      sessions: [
        { sessionId: 'session:group:new', spaceId: 'group:session:group:shared', parentSessionId: null },
        { sessionId: 'session:group:old', spaceId: 'group:session:group:shared', parentSessionId: null },
      ],
      collapsedForkParentIds: new Set<string>(),
      activeSessionId,
      includeSpaceRows: true,
    }), [activeSessionId]);

    return (
      <VirtualChatList
        rows={rows}
        activeSessionId={activeSessionId}
        scrollStyle={{ height: 240 }}
        renderRow={(row) => row.kind === 'session' ? (
          <button
            type="button"
            data-group-session-id={row.sessionId}
            data-test-row-height="48"
            className={row.sessionId === activeSessionId ? 'app-session-row-active' : ''}
            onClick={() => {
              selectedIds.push(row.sessionId);
              setActiveSessionId(row.sessionId);
            }}
          >
            {row.sessionId}
          </button>
        ) : <div data-test-row-height="48">Shared group</div>}
      />
    );
  }

  await act(async () => root?.render(<GroupSessionHarness />));
  await flush();
  const oldSession = host.querySelector<HTMLButtonElement>('[data-group-session-id="session:group:old"]');
  assert.ok(oldSession);
  assert.equal(host.querySelector('.app-session-row-active')?.getAttribute('data-group-session-id'), 'session:group:new');

  await act(async () => oldSession.click());
  await flush();

  assert.deepEqual(selectedIds, ['session:group:old']);
  assert.equal(host.querySelectorAll('.app-session-row-active').length, 1);
  assert.equal(host.querySelector('.app-session-row-active')?.getAttribute('data-group-session-id'), 'session:group:old');
});
```

- [ ] **Step 2: Run the sidebar regression**

Run:

```bash
pnpm --dir app/desktop exec tsx --test --test-name-pattern="two sessions in one group space" tests/virtualSidebar.test.tsx
```

Expected: PASS, confirming the foreground virtualized row path switches exact IDs when background rendering is stable.

- [ ] **Step 3: Run related sidebar and routing suites**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/virtualSidebar.test.tsx tests/workspaceSidebarParticipantSpaces.test.tsx tests/chatRouting.test.tsx
```

Expected: all tests pass.

- [ ] **Step 4: Commit the selection regression**

```bash
git add app/desktop/tests/virtualSidebar.test.tsx
git commit -m "test: cover switching grouped child sessions"
```

### Task 4: Full Verification and Live Reproduction

**Files:**
- Verify only; no planned source changes.

- [ ] **Step 1: Run formatting and static checks**

Run:

```bash
git diff --check
pnpm --dir app/desktop typecheck
```

Expected: both commands exit 0.

- [ ] **Step 2: Run the complete desktop unit suite**

Run:

```bash
pnpm --dir app/desktop test:unit
```

Expected: all desktop unit tests pass with zero failures.

- [ ] **Step 3: Relaunch the preserved `user1` instance**

Stop only the current `user1` development process, preserve `app/desktop/.multi-instance-data/user1`, then run:

```bash
KORDI_CLOUD_API_BASE=https://coordinar.io \
VITE_KORDI_CLOUD_API_BASE=https://coordinar.io \
VITE_KORDI_PERF_DIAGNOSTICS=1 \
pnpm --dir app/desktop tauri:dev:multi -- --users user1
```

Expected: Kordi opens on port 1482 using the existing account and canonical session database.

- [ ] **Step 4: Verify startup replay is bounded**

Inspect only the new launch section of `app/desktop/.multi-instance-logs/user1/dev-1482.log`.

Expected:

- no `Maximum update depth exceeded` lines;
- failures, if any, appear as bounded `retry scheduled` warnings with increasing cooldowns;
- the window remains responsive.

- [ ] **Step 5: Verify real grouped-session switching**

In the expanded group containing `# hiiiii` and `# hiii`:

1. Click `# hiii`.
2. Confirm the blue highlight moves to `# hiii`.
3. Confirm the transcript shows the older 139-message session.
4. Click `# hiiiii`.
5. Confirm the highlight and two-message transcript switch back together.

Expected: every click selects the exact child session without clicking the parent group row.

- [ ] **Step 6: Review final branch state**

Run:

```bash
git status --short --branch
git log --oneline -5
```

Expected: branch `fix/group-session-switch-replay-loop`, clean worktree, and separate commits for coordinator, integration, and regression coverage.

### Task 5: Stop Canonical No-op Updates from Rebuilding the Sidebar

**Files:**
- Modify: `app/desktop/tests/canonicalCatalog.test.tsx`
- Modify: `app/desktop/src/features/canonical/canonicalStore.ts`
- Modify: `app/desktop/src/app/useKordiAppModel.ts`

- [x] **Step 1: Reproduce the warning with a component stack**

Temporarily attach a stack to the React update-depth warning in the live `user1` renderer. Confirm the repeated dispatch originates in Cloud unread reconciliation through `setCanonicalSessionState`, then remove the instrumentation.

- [x] **Step 2: Add a failing canonical adapter test**

Assert that a functional action returning its current canonical state returns the exact existing `CanonicalStore`. Confirm the test fails before the adapter exists.

- [x] **Step 3: Preserve identity for logical no-op updates**

Add `applyCanonicalSessionStateAction`, use it in `useKordiAppModel`, and skip `updateCanonicalStore` dispatch when the next store is identity-equal to the current store.

- [x] **Step 4: Verify the focused contract and live renderer**

Run the canonical catalog, Cloud bridge, and replay coordinator suites plus TypeScript checking. Clean-restart `user1`, verify no update-depth or replay-loop errors, and sample both child-session hover regions repeatedly to confirm stable pixels.

### Task 6: Remove the Native Group-child Hover Flicker

**Files:**
- Modify: `app/desktop/tests/workspaceSidebarParticipantSpaces.test.tsx`
- Modify: `app/desktop/src/pages/WorkspaceSidebar.tsx`

- [x] **Step 1: Reproduce with a real mouse event**

Post a real macOS `mouseMoved` event over the group child label and capture the two child rows repeatedly. Confirm the native `# hiiiii` tooltip appears and the hovered row alternates between dark and blue.

- [x] **Step 2: Isolate the native tooltip trigger**

Temporarily remove the child title's HTML `title` attribute and repeat the same capture. Confirm all 30 captured frames are identical, then restore the source before starting implementation.

- [x] **Step 3: Add the failing markup regression**

Assert that the hashtag child title stays visible but its span does not emit a native `title` attribute. Confirm the test fails against the original markup.

- [x] **Step 4: Implement and verify the minimal fix**

Remove the native tooltip attribute from group child title spans. Confirm the focused test and sidebar suites pass, then repeat the real hover capture and require every frame after the initial CSS transition to remain identical.
