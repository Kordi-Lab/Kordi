# Desktop Full-Suite Repairs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the remaining 15 desktop unit-test failures by hardening preference storage, correcting LM Studio passkey detection, and reconciling two intentional UI data contracts.

**Architecture:** Centralize safe Web Storage resolution and operations in a small Cloud preference utility consumed by avatar and login-mode preferences. Keep the other repairs local: one normalized matcher correction and exact test expectations for participant presence and Cloud task visibility.

**Tech Stack:** TypeScript, React server rendering, Web Storage API, Node test runner, pnpm/tsx.

---

## File Structure

- Create `app/desktop/src/features/cloud/preferenceStorage.ts` — validate and safely invoke the Web Storage subset used by Cloud preferences.
- Modify `app/desktop/src/features/cloud/avatarPreference.ts` — use safe preference storage operations.
- Modify `app/desktop/src/features/cloud/loginModePreference.ts` — use safe preference storage operations.
- Modify `app/desktop/tests/cloudAvatarPreference.test.tsx` — deterministic unusable and throwing storage regressions.
- Modify `app/desktop/src/kordi-app/auth/LmStudioModelControlCenter.tsx` — fix normalized passkey repair matching.
- Modify `app/desktop/tests/participantSpaces.test.tsx` — assert the intentional presence field.
- Modify `app/desktop/tests/projectTaskActivityPanel.test.tsx` — assert intentional canonical Cloud task visibility.

### Task 1: Make Cloud Preference Storage Safe

**Files:**
- Create: `app/desktop/src/features/cloud/preferenceStorage.ts`
- Modify: `app/desktop/src/features/cloud/avatarPreference.ts`
- Modify: `app/desktop/src/features/cloud/loginModePreference.ts`
- Modify: `app/desktop/tests/cloudAvatarPreference.test.tsx`

- [ ] **Step 1: Add a deterministic failing storage regression**

Import `clearLoginModePreference` in `app/desktop/tests/cloudAvatarPreference.test.tsx`, then add:

```ts
test('Cloud preferences ignore unusable and inaccessible storage implementations', () => {
  const unusable = {} as Storage;
  const inaccessible = {
    getItem: () => { throw new Error('blocked'); },
    setItem: () => { throw new Error('blocked'); },
    removeItem: () => { throw new Error('blocked'); },
  } as unknown as Storage;

  for (const storage of [unusable, inaccessible]) {
    assert.equal(readAvatarPreference(storage), null);
    assert.equal(writeAvatarPreference({ kind: 'upload', dataUrl: 'data:image/jpeg;base64,abc' }, storage), false);
    assert.doesNotThrow(() => clearAvatarPreference(storage));
    assert.equal(readLoginModePreference(storage), null);
    assert.doesNotThrow(() => writeLoginModePreference('login', storage));
    assert.doesNotThrow(() => clearLoginModePreference(storage));
  }
});
```

- [ ] **Step 2: Run the storage test and verify RED**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/cloudAvatarPreference.test.tsx tests/cloudEdition.test.tsx
```

Expected: the new unusable-storage regression fails, and Cloud login server-render tests fail with `target.getItem is not a function` under the current Node 25 environment.

- [ ] **Step 3: Add the safe preference storage utility**

Create `app/desktop/src/features/cloud/preferenceStorage.ts`:

```ts
function hasPreferenceStorageMethods(value: unknown): value is Storage {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return false;
  const candidate = value as Partial<Storage>;
  return typeof candidate.getItem === 'function'
    && typeof candidate.setItem === 'function'
    && typeof candidate.removeItem === 'function';
}

export function resolvePreferenceStorage(storage?: Storage): Storage | null {
  try {
    const candidate = storage === undefined
      ? (globalThis as { localStorage?: unknown }).localStorage
      : storage;
    return hasPreferenceStorageMethods(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

export function readPreferenceStorageItem(storage: Storage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

export function writePreferenceStorageItem(storage: Storage, key: string, value: string): boolean {
  try {
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function removePreferenceStorageItem(storage: Storage, key: string): void {
  try {
    storage.removeItem(key);
  } catch {
    // Storage is optional; inaccessible preferences are treated as absent.
  }
}
```

- [ ] **Step 4: Route avatar preferences through safe storage**

In `avatarPreference.ts`, import the four helpers, remove the local `resolveStorage`, replace `target.getItem` with `readPreferenceStorageItem`, replace the guarded `setItem` block with `writePreferenceStorageItem`, and replace `removeItem` calls with `removePreferenceStorageItem`.

The write return becomes:

```ts
return writePreferenceStorageItem(target, AVATAR_PREFERENCE_STORAGE_KEY, JSON.stringify(normalized));
```

- [ ] **Step 5: Route login-mode preferences through safe storage**

In `loginModePreference.ts`, import the four helpers, remove the local `resolveStorage`, read through `readPreferenceStorageItem`, write through `writePreferenceStorageItem`, and clear through `removePreferenceStorageItem`.

- [ ] **Step 6: Run the storage and Cloud login tests**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/cloudAvatarPreference.test.tsx tests/cloudEdition.test.tsx
```

Expected: 38 tests pass, zero fail.

- [ ] **Step 7: Commit safe preference storage**

```bash
git add \
  app/desktop/src/features/cloud/preferenceStorage.ts \
  app/desktop/src/features/cloud/avatarPreference.ts \
  app/desktop/src/features/cloud/loginModePreference.ts \
  app/desktop/tests/cloudAvatarPreference.test.tsx
git commit -m "fix: tolerate unavailable preference storage"
```

### Task 2: Correct LM Studio Repair Detection

**Files:**
- Modify: `app/desktop/src/kordi-app/auth/LmStudioModelControlCenter.tsx:129`
- Test: `app/desktop/tests/lmStudioControlCenter.test.tsx`

- [ ] **Step 1: Preserve the existing RED regression**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/lmStudioControlCenter.test.tsx
```

Expected: 3 tests pass and `lmStudioDisplayError turns invalid passkey stack dumps into repair guidance` fails because the generated repair message is not recognized.

- [ ] **Step 2: Normalize the comparison needle**

Change the second matcher branch to:

```ts
|| normalized.includes('rejected the lms cli passkey')
```

- [ ] **Step 3: Run the LM Studio regression**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/lmStudioControlCenter.test.tsx
```

Expected: 4 tests pass, zero fail.

- [ ] **Step 4: Commit the matcher correction**

```bash
git add app/desktop/src/kordi-app/auth/LmStudioModelControlCenter.tsx
git commit -m "fix: recognize LM Studio repair guidance"
```

### Task 3: Reconcile Presence and Cloud Task Contracts

**Files:**
- Modify: `app/desktop/tests/participantSpaces.test.tsx:154`
- Modify: `app/desktop/tests/projectTaskActivityPanel.test.tsx:8,70-74`

- [ ] **Step 1: Preserve both existing RED regressions**

Run:

```bash
pnpm --dir app/desktop exec tsx --test \
  tests/participantSpaces.test.tsx \
  tests/projectTaskActivityPanel.test.tsx
```

Expected: one stale assertion fails in each file.

- [ ] **Step 2: Assert the participant presence field**

Change the expected inferred avatar to:

```ts
[{ kind: 'human', seed: 'human-local', imageUrl: null, presenceStatus: null }]
```

- [ ] **Step 3: Assert visible canonical Cloud task activity**

Rename the project test to `project detail task panel renders synced delegated Cloud task activity rows` and replace its old empty-state assertions with:

```ts
assert.doesNotMatch(markup, /No planning or execution task activity in this project session yet/);
assert.match(markup, /app-inspector-source-row/);
assert.match(markup, /Remote Kordi/);
assert.match(markup, /Synced Cloud task by Me\./);
assert.match(markup, /ID:\s*bridge_req_project_task/);
assert.match(markup, /aria-label="Task target participants"/);
assert.doesNotMatch(markup, /Delegated by Me/);
```

- [ ] **Step 4: Run the reconciled contract tests**

Run:

```bash
pnpm --dir app/desktop exec tsx --test \
  tests/participantSpaces.test.tsx \
  tests/projectTaskActivityPanel.test.tsx
```

Expected: 22 tests pass, zero fail.

- [ ] **Step 5: Commit the current contracts**

```bash
git add \
  app/desktop/tests/participantSpaces.test.tsx \
  app/desktop/tests/projectTaskActivityPanel.test.tsx
git commit -m "test: reconcile presence and Cloud task contracts"
```

### Task 4: Verify the Complete Repair Batch

**Files:**
- Verify all files changed in Tasks 1-3.

- [ ] **Step 1: Run all affected tests together**

Run:

```bash
pnpm --dir app/desktop exec tsx --test \
  tests/cloudAvatarPreference.test.tsx \
  tests/cloudEdition.test.tsx \
  tests/lmStudioControlCenter.test.tsx \
  tests/participantSpaces.test.tsx \
  tests/projectTaskActivityPanel.test.tsx
```

Expected: 64 tests pass, zero fail.

- [ ] **Step 2: Run desktop type checking**

Run:

```bash
pnpm --dir app/desktop typecheck
```

Expected: exit zero with no TypeScript errors.

- [ ] **Step 3: Run the complete desktop unit suite**

Run:

```bash
pnpm --dir app/desktop test:unit
```

Expected: all tests pass with zero failures.

- [ ] **Step 4: Inspect repository state**

Run:

```bash
git status --short --branch
git log --oneline -8
```

Expected: the worktree is clean and the three repair commits are present above the design and plan commits.
