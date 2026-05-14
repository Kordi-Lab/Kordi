# Cloud Post-Login Starting State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a minimal three-dot Cloud starting screen after login until initial canonical and Cloud sync readiness settles.

**Architecture:** Reuse the existing Cloud gate shell and existing sync hooks. Add explicit first-sync-settled signals to Cloud contacts and Cloud bridge state, derive a `cloudInitialSync` gate in `useKordiAppModel`, and have `KordiAppShell` render a lightweight starting screen instead of the main shell until ready.

**Tech Stack:** React, TypeScript, Tauri desktop APIs, Node test runner via `pnpm --dir app/desktop test:unit`, CSS theme tokens.

---

## File Structure

- Modify `app/desktop/src/features/cloud/useCloudContacts.ts`: expose `initialLoadSettled` and `refresh` already exists.
- Modify `app/desktop/src/features/cloud/useCloudBridgeState.ts`: expose `initialMessagesSettled` and ensure no-contact accounts settle instead of waiting forever.
- Modify `app/desktop/src/app/useKordiAppModel.ts`: track first canonical fetch settlement and return `cloudInitialSync` readiness metadata.
- Modify `app/desktop/src/KordiApp.tsx`: render `CloudStartingScreen` while `cloudInitialSync.status !== 'ready'` for Cloud authenticated startup.
- Modify `app/desktop/src/styles/theme-overrides.css`: add flat watercolor three-dot loader styles for light/dark themes and reduced motion.
- Modify `app/desktop/tests/cloudEdition.test.tsx`: add root/screen render assertions.
- Modify or create `app/desktop/tests/cloudInitialSync.test.tsx`: unit-test readiness helper if extracted.

---

### Task 1: Add first-load settled signals

**Files:**
- Modify: `app/desktop/src/features/cloud/useCloudContacts.ts`
- Modify: `app/desktop/src/features/cloud/useCloudBridgeState.ts`
- Test: `app/desktop/tests/cloudBridgeState.test.tsx` or new focused test if helper extraction is needed

- [ ] **Step 1: Write the failing tests**

Add tests that prove no-contact Cloud bridge state can report first message refresh settled, and contact loading exposes a first-settled boolean if directly testable through helpers. If hooks are not practical to render directly, cover the exported readiness helper in Task 2 instead.

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
pnpm --dir app/desktop test:unit -- cloudBridgeState.test.tsx cloudInitialSync.test.tsx
```

Expected: fails because the settled/readiness API does not exist.

- [ ] **Step 3: Implement settled signals**

In `UseCloudContactsResult`, add:

```ts
initialLoadSettled: boolean;
```

In `useCloudContacts`, add state:

```ts
const [initialLoadSettled, setInitialLoadSettled] = useState(false);
```

Reset it when account clears and set it in `fetchData` finally. If there is no account, return settled true for the skipped state.

In `UseCloudBridgeStateResult`, add:

```ts
initialMessagesSettled: boolean;
```

In `useCloudBridgeState`, add state and set it true after the first refresh attempt settles, including the `!account || contactPeerIds.length === 0` skipped path.

- [ ] **Step 4: Run tests to verify GREEN**

Run:

```bash
pnpm --dir app/desktop test:unit -- cloudBridgeState.test.tsx cloudInitialSync.test.tsx
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add app/desktop/src/features/cloud/useCloudContacts.ts app/desktop/src/features/cloud/useCloudBridgeState.ts app/desktop/tests
git commit -m "feat(cloud): expose initial sync readiness signals"
```

---

### Task 2: Derive Cloud initial sync readiness

**Files:**
- Modify: `app/desktop/src/app/useKordiAppModel.ts`
- Create: `app/desktop/src/features/cloud/initialSync.ts`
- Test: `app/desktop/tests/cloudInitialSync.test.tsx`

- [ ] **Step 1: Write the failing tests**

Create tests for:
- pending while canonical fetch has not settled
- ready for canonical profile with empty sessions after contacts/messages settled
- ready for canonical profile with sessions after contacts/messages settled
- timeout/error when elapsed time exceeds the chosen timeout and readiness is still pending

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
pnpm --dir app/desktop test:unit -- cloudInitialSync.test.tsx
```

Expected: fail because `cloudInitialSyncStatus` does not exist.

- [ ] **Step 3: Implement helper**

Create `app/desktop/src/features/cloud/initialSync.ts` exporting:

```ts
export type CloudInitialSyncStatus = 'syncing' | 'ready' | 'error';
export const CLOUD_INITIAL_SYNC_TIMEOUT_MS = 15_000;

export function cloudInitialSyncStatus(input: {
  isCloudEdition: boolean;
  accountReady: boolean;
  canonicalSettled: boolean;
  canonicalReady: boolean;
  contactsSettled: boolean;
  messagesSettled: boolean;
  startedAtMs: number;
  nowMs?: number;
}): CloudInitialSyncStatus {
  if (!input.isCloudEdition || !input.accountReady) return 'ready';
  if (input.canonicalReady && input.canonicalSettled && input.contactsSettled && input.messagesSettled) return 'ready';
  const now = input.nowMs ?? Date.now();
  return now - input.startedAtMs >= CLOUD_INITIAL_SYNC_TIMEOUT_MS ? 'error' : 'syncing';
}
```

- [ ] **Step 4: Wire helper into `useKordiAppModel`**

Track `canonicalInitialFetchSettled`, set it after the first `refreshCanonicalState` attempt completes, and include `cloudInitialSync` in the returned model:

```ts
cloudInitialSync: {
  status,
  retry: refreshCloudInitialSync,
}
```

- [ ] **Step 5: Run tests to verify GREEN**

Run:

```bash
pnpm --dir app/desktop test:unit -- cloudInitialSync.test.tsx
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add app/desktop/src/app/useKordiAppModel.ts app/desktop/src/features/cloud/initialSync.ts app/desktop/tests/cloudInitialSync.test.tsx
git commit -m "feat(cloud): gate startup on initial sync readiness"
```

---

### Task 3: Render the watercolor dot starting screen

**Files:**
- Modify: `app/desktop/src/KordiApp.tsx`
- Modify: `app/desktop/src/styles/theme-overrides.css`
- Test: `app/desktop/tests/cloudEdition.test.tsx`

- [ ] **Step 1: Write the failing tests**

Add render tests asserting:
- Cloud loading screen uses `app-cloud-starting-dots`.
- It does not render visible “Starting”.
- It renders exactly three dot elements.
- Authenticated Cloud shell can render the starting gate when model status is syncing if dependency injection is added.

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
pnpm --dir app/desktop test:unit -- cloudEdition.test.tsx
```

Expected: fail because the three-dot starting screen is not implemented.

- [ ] **Step 3: Implement `CloudStartingScreen`**

Replace `CloudGateLoading` with a reusable screen:

```tsx
export function CloudStartingScreen({ onRetry, failed = false }: { onRetry?: () => void; failed?: boolean }) {
  return (
    <div className="app-cloud-starting-screen fixed inset-0 z-[100] grid place-items-center" aria-live="polite" aria-busy={!failed}>
      {failed ? (
        <div className="app-cloud-starting-error">
          <div>Couldn’t start Kordi</div>
          {onRetry ? <button type="button" onClick={onRetry}>Try again</button> : null}
        </div>
      ) : (
        <div className="app-cloud-starting-dots" aria-label="Kordi is starting">
          <span />
          <span />
          <span />
        </div>
      )}
    </div>
  );
}
```

Use it for both session `status === 'loading'` and post-login `cloudInitialSync.status === 'syncing'`.

- [ ] **Step 4: Add CSS**

Add flat watercolor dot styles in `theme-overrides.css` using `--app-cloud-login-page-bg` background, three soft theme colors, staggered low-amplitude animation, and `prefers-reduced-motion` fallback.

- [ ] **Step 5: Run tests to verify GREEN**

Run:

```bash
pnpm --dir app/desktop test:unit -- cloudEdition.test.tsx cloudInitialSync.test.tsx
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add app/desktop/src/KordiApp.tsx app/desktop/src/styles/theme-overrides.css app/desktop/tests/cloudEdition.test.tsx
git commit -m "feat(cloud): show post-login starting screen"
```

---

### Task 4: Final verification

**Files:**
- All modified files

- [ ] **Step 1: Typecheck**

Run:

```bash
pnpm --dir app/desktop typecheck
```

Expected: exit 0.

- [ ] **Step 2: Focused tests**

Run:

```bash
pnpm --dir app/desktop test:unit -- cloudEdition.test.tsx cloudInitialSync.test.tsx cloudBridgeState.test.tsx
```

Expected: pass.

- [ ] **Step 3: Commit any final fixes**

```bash
git status --short
git add <changed-files>
git commit -m "test(cloud): cover starting sync gate"
```

Skip this commit if there are no changes.
