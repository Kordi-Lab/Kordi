# Main Cloud Surface Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clean Cloud Edition so Projects is not exposed and Cloud settings only shows Authentication and Theme.

**Architecture:** Add edition-aware navigation/settings selectors in the data layer, then have the shell consume those filtered surfaces and recover stale persisted state. Keep Local Edition defaults unchanged.

**Tech Stack:** React, TypeScript, node:test via `tsx`, existing `currentKordiEdition()` edition helpers.

---

### Task 1: Add edition-aware surface selectors

**Files:**
- Modify: `app/desktop/src/kordi-app/data/navigation.tsx`
- Modify: `app/desktop/src/kordi-app/data/settings.tsx`
- Test: `app/desktop/tests/cloudSurfaceCleanup.test.ts`

- [ ] **Step 1: Write failing tests**

Create `app/desktop/tests/cloudSurfaceCleanup.test.ts` with tests that assert:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { navItemsForEdition, normalizeNavIdForEdition } from '../src/kordi-app/data/navigation';
import { normalizeSettingsSectionIdForEdition, settingsSectionsForEdition } from '../src/kordi-app/data/settings';

test('cloud navigation hides projects and redirects stale project nav to chats', () => {
  assert.deepEqual(navItemsForEdition('cloud').map((item) => item.id), ['chats', 'contacts', 'agents', 'settings']);
  assert.equal(normalizeNavIdForEdition('cloud', 'projects'), 'chats');
  assert.equal(normalizeNavIdForEdition('local', 'projects'), 'projects');
});

test('cloud settings only exposes authentication and theme', () => {
  const cloudSections = settingsSectionsForEdition('cloud');
  assert.deepEqual(cloudSections.map((section) => section.id), ['auth', 'appearance']);
  assert.deepEqual(cloudSections.map((section) => section.label), ['Authentication', 'Theme']);
  assert.deepEqual(cloudSections[1]?.items.map((item) => item.label), ['Theme']);
  assert.equal(normalizeSettingsSectionIdForEdition('cloud', 'general'), 'auth');
  assert.equal(normalizeSettingsSectionIdForEdition('cloud', 'appearance'), 'appearance');
});
```

- [ ] **Step 2: Verify red**

Run: `pnpm --dir app/desktop exec tsx --test tests/cloudSurfaceCleanup.test.ts`

Expected: FAIL because the selector exports do not exist.

- [ ] **Step 3: Implement selectors**

Add `allNavItems`, `navItemsForEdition()`, and `normalizeNavIdForEdition()` in `navigation.tsx`; keep `navItems` as the current-edition export.

Add `allSettingsSections`, `settingsSectionsForEdition()`, and `normalizeSettingsSectionIdForEdition()` in `settings.tsx`; keep `settingsSections` as the current-edition export. For Cloud, return Authentication and a Theme-only Appearance section labeled/title `Theme`.

- [ ] **Step 4: Verify green**

Run: `pnpm --dir app/desktop exec tsx --test tests/cloudSurfaceCleanup.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add app/desktop/src/kordi-app/data/navigation.tsx app/desktop/src/kordi-app/data/settings.tsx app/desktop/tests/cloudSurfaceCleanup.test.ts
git commit -m "Add cloud surface selectors"
```

### Task 2: Wire filtered surfaces into app state

**Files:**
- Modify: `app/desktop/src/app/useKordiAppModel.ts`
- Modify: `app/desktop/src/app/useKordiDesktopActivity.ts`
- Test: `app/desktop/tests/cloudSurfaceCleanup.test.ts`

- [ ] **Step 1: Add failing source-level wiring assertions**

Extend `cloudSurfaceCleanup.test.ts` to assert `useKordiAppModel.ts` imports and uses `settingsSectionsForEdition`, `normalizeNavIdForEdition`, and `normalizeSettingsSectionIdForEdition`.

- [ ] **Step 2: Verify red**

Run: `pnpm --dir app/desktop exec tsx --test tests/cloudSurfaceCleanup.test.ts`

Expected: FAIL because the app is not wired to the helpers.

- [ ] **Step 3: Implement wiring**

In `useKordiAppModel.ts`, compute `visibleSettingsSections = settingsSectionsForEdition(kordiEdition)` and add effects that redirect stale nav/settings ids. Pass `visibleSettingsSections` into `useKordiDesktopActivity()` and shell args.

In `useKordiDesktopActivity.ts`, accept a `settingsSections` argument and compute `activeSettingsSection` from that list.

- [ ] **Step 4: Verify green**

Run: `pnpm --dir app/desktop exec tsx --test tests/cloudSurfaceCleanup.test.ts tests/cloudEdition.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add app/desktop/src/app/useKordiAppModel.ts app/desktop/src/app/useKordiDesktopActivity.ts app/desktop/tests/cloudSurfaceCleanup.test.ts
git commit -m "Wire cloud surface cleanup into shell state"
```

### Task 3: Final verification

- [ ] Run: `pnpm --dir app/desktop exec tsx --test tests/cloudSurfaceCleanup.test.ts tests/cloudEdition.test.tsx tests/authLaunchSurface.test.ts`
- [ ] Run: `pnpm --dir app/desktop typecheck`
- [ ] Commit any final fixes.
