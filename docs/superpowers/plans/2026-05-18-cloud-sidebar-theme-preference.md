# Cloud Sidebar Hierarchy and Theme Preference Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve Cloud sidebar session hierarchy so the active row is visually dominant, and persist the app theme preference with `auto` as the default.

**Architecture:** This is a Cloud-based polish pass on `main-cloud`. Sidebar hierarchy changes stay at the existing CSS + row-render boundaries (`WorkspaceSidebar.tsx`, `shell.css`, `shell-sidebar.css`, `theme-overrides.css`) so no conversation data model changes are needed. Theme persistence is isolated into a small `themePreference.ts` helper used by both the main shell state and the Cloud login/restoring gate, preventing theme flash and preserving preference across logout/restart.

**Tech Stack:** React 19, TypeScript, Tauri desktop shell, CSS modules/global styles, Node `tsx --test`.

---

## Code Review Notes

- `app/desktop/src/styles/shell.css` already has `.app-session-row` and `.app-session-row-active`, but the active state is mostly a faint ring and low-chroma filled background. `theme-overrides.css` also explicitly removes light-theme shadow from `.app-workspace-sidebar .app-session-row-active`, which works against #474.
- `app/desktop/src/styles/shell-sidebar.css` adds sidebar-specific active styling and participant child row styling. This is the safest place for most sidebar hierarchy changes because it only affects the workspace sidebar.
- `WorkspaceSidebar.tsx` renders two important session-row families:
  - participant-space/group child rows around lines ~720-780
  - agent session rows around lines ~1160-1245
  Both hard-code `tracking-[0.03em]` on time labels and have title classes that do not consistently distinguish active from inactive.
- Participant-space action buttons are always in the layout and visibly inked at rest. They can be kept in layout but faded with CSS (`opacity: 0; pointer-events: none`) to avoid layout shift.
- `app/desktop/src/app/useKordiLocalUiState.ts` initializes `themeMode` with `'dark'` and exposes the raw setter. There is no read/write persistence.
- `KordiApp.tsx` gate theme currently follows system preference only. It should instead read the persisted mode synchronously, resolve `auto` through system preference, then keep responding to OS changes only when the stored preference is `auto`.

---

### Task 1: Add persistent theme preference helpers

**Files:**
- Create: `app/desktop/src/app/themePreference.ts`
- Create: `app/desktop/tests/themePreference.test.ts`

- [ ] **Step 1: Write the failing helper tests**

Create `app/desktop/tests/themePreference.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  KORDI_THEME_MODE_STORAGE_KEY,
  readStoredThemeMode,
  resolveThemeMode,
  writeStoredThemeMode,
} from '../src/app/themePreference';

type StorageStub = Pick<Storage, 'getItem' | 'setItem'> & { values: Map<string, string> };

function storage(initial: Record<string, string> = {}): StorageStub {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, String(value)); },
  };
}

test('theme preference defaults to auto for brand-new installs', () => {
  assert.equal(readStoredThemeMode(storage()), 'auto');
  assert.equal(readStoredThemeMode(undefined), 'auto');
});

test('theme preference reads only valid stored modes', () => {
  assert.equal(readStoredThemeMode(storage({ [KORDI_THEME_MODE_STORAGE_KEY]: 'light' })), 'light');
  assert.equal(readStoredThemeMode(storage({ [KORDI_THEME_MODE_STORAGE_KEY]: 'dark' })), 'dark');
  assert.equal(readStoredThemeMode(storage({ [KORDI_THEME_MODE_STORAGE_KEY]: 'auto' })), 'auto');
  assert.equal(readStoredThemeMode(storage({ [KORDI_THEME_MODE_STORAGE_KEY]: 'system' })), 'auto');
  assert.equal(readStoredThemeMode(storage({ [KORDI_THEME_MODE_STORAGE_KEY]: '{bad json' })), 'auto');
});

test('theme preference writes under a stable v1 key', () => {
  const target = storage();

  writeStoredThemeMode('dark', target);

  assert.equal(KORDI_THEME_MODE_STORAGE_KEY, 'kordi.themeMode.v1');
  assert.equal(target.values.get(KORDI_THEME_MODE_STORAGE_KEY), 'dark');
});

test('theme resolver follows system mode only when preference is auto', () => {
  assert.equal(resolveThemeMode('auto', 'light'), 'light');
  assert.equal(resolveThemeMode('auto', 'dark'), 'dark');
  assert.equal(resolveThemeMode('light', 'dark'), 'light');
  assert.equal(resolveThemeMode('dark', 'light'), 'dark');
});
```

- [ ] **Step 2: Run the failing helper tests**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/themePreference.test.ts
```

Expected: FAIL with module not found for `../src/app/themePreference`.

- [ ] **Step 3: Implement `themePreference.ts`**

Create `app/desktop/src/app/themePreference.ts`:

```ts
import type { ResolvedThemeMode, ThemeMode } from '@/kordi-app/types';

export const KORDI_THEME_MODE_STORAGE_KEY = 'kordi.themeMode.v1';

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'light' || value === 'dark' || value === 'auto';
}

function browserStorage(): Pick<Storage, 'getItem' | 'setItem'> | undefined {
  try {
    if (typeof window === 'undefined') return undefined;
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function readStoredThemeMode(storage: Pick<Storage, 'getItem'> | undefined = browserStorage()): ThemeMode {
  try {
    const value = storage?.getItem(KORDI_THEME_MODE_STORAGE_KEY);
    return isThemeMode(value) ? value : 'auto';
  } catch {
    return 'auto';
  }
}

export function writeStoredThemeMode(
  mode: ThemeMode,
  storage: Pick<Storage, 'setItem'> | undefined = browserStorage(),
): void {
  try {
    storage?.setItem(KORDI_THEME_MODE_STORAGE_KEY, mode);
  } catch {
    // Ignore unavailable localStorage; in-memory React state remains correct.
  }
}

export function resolveThemeMode(themeMode: ThemeMode, systemThemeMode: ResolvedThemeMode): ResolvedThemeMode {
  return themeMode === 'auto' ? systemThemeMode : themeMode;
}
```

- [ ] **Step 4: Verify helper tests pass**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/themePreference.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/desktop/src/app/themePreference.ts app/desktop/tests/themePreference.test.ts
git commit -m "Persist theme preference helpers"
```

---

### Task 2: Wire persisted `auto` theme into the main Cloud shell state

**Files:**
- Modify: `app/desktop/src/app/useKordiLocalUiState.ts`
- Create: `app/desktop/tests/useKordiLocalUiStateTheme.test.ts`

- [ ] **Step 1: Write source-level regression tests**

Create `app/desktop/tests/useKordiLocalUiStateTheme.test.ts`:

```ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('../src/app/useKordiLocalUiState.ts', import.meta.url), 'utf8');

test('local UI state initializes theme synchronously from persisted preference', () => {
  assert.match(source, /useState<ThemeMode>\(\(\) => readStoredThemeMode\(\)\)/);
  assert.doesNotMatch(source, /useState<ThemeMode>\('dark'\)/);
});

test('local UI state persists explicit theme changes through the exposed setter', () => {
  assert.match(source, /writeStoredThemeMode\(nextThemeMode\)/);
  assert.match(source, /const setThemeMode: Dispatch<SetStateAction<ThemeMode>> = useCallback/);
});

test('local UI state resolves auto theme through live system mode', () => {
  assert.match(source, /resolveThemeMode\(themeMode, systemThemeMode\)/);
  assert.match(source, /mediaQuery\.addEventListener\('change', updateSystemThemeMode\)/);
});
```

- [ ] **Step 2: Run tests and confirm failure**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/useKordiLocalUiStateTheme.test.ts
```

Expected: FAIL because `useKordiLocalUiState.ts` still uses `useState<ThemeMode>('dark')` and does not import helper functions.

- [ ] **Step 3: Update imports and theme state in `useKordiLocalUiState.ts`**

Change the first line:

```ts
import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react';
```

Add helper import:

```ts
import { readStoredThemeMode, resolveThemeMode, writeStoredThemeMode } from '@/app/themePreference';
```

Replace the current theme state block:

```ts
const [themeMode, setThemeMode] = useState<ThemeMode>('dark');
const [systemThemeMode, setSystemThemeMode] = useState<ResolvedThemeMode>(() => getSystemThemeMode());
const resolvedThemeMode: ResolvedThemeMode = themeMode === 'auto' ? systemThemeMode : themeMode;
```

with:

```ts
const [themeMode, setThemeModeState] = useState<ThemeMode>(() => readStoredThemeMode());
const setThemeMode: Dispatch<SetStateAction<ThemeMode>> = useCallback((nextThemeModeOrUpdater) => {
  setThemeModeState((currentThemeMode) => {
    const nextThemeMode = typeof nextThemeModeOrUpdater === 'function'
      ? nextThemeModeOrUpdater(currentThemeMode)
      : nextThemeModeOrUpdater;
    writeStoredThemeMode(nextThemeMode);
    return nextThemeMode;
  });
}, []);
const [systemThemeMode, setSystemThemeMode] = useState<ResolvedThemeMode>(() => getSystemThemeMode());
const resolvedThemeMode: ResolvedThemeMode = resolveThemeMode(themeMode, systemThemeMode);
```

- [ ] **Step 4: Run focused tests**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/themePreference.test.ts tests/useKordiLocalUiStateTheme.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/desktop/src/app/useKordiLocalUiState.ts app/desktop/tests/useKordiLocalUiStateTheme.test.ts
git commit -m "Persist local theme preference"
```

---

### Task 3: Make the Cloud login/restoring gate respect persisted theme preference

**Files:**
- Modify: `app/desktop/src/KordiApp.tsx`
- Modify: `app/desktop/tests/cloudEdition.test.tsx`

- [ ] **Step 1: Add source-level tests for the gate**

Append to `app/desktop/tests/cloudEdition.test.tsx`:

```ts
test('cloud login gate reads persisted theme preference before shell mount', () => {
  const source = readSource('src/KordiApp.tsx');

  assert.match(source, /readStoredThemeMode/);
  assert.match(source, /resolveThemeMode\(themeMode, readSystemTheme\(\)\)/);
  assert.match(source, /setTheme\(resolveThemeMode\(themeMode, mediaQuery\.matches \? 'light' : 'dark'\)\)/);
  assert.doesNotMatch(source, /const \[theme, setTheme\] = useState<ResolvedThemeMode>\(\(\) => readSystemTheme\(\)\)/);
});
```

- [ ] **Step 2: Run the failing gate test**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/cloudEdition.test.tsx
```

Expected: FAIL because `KordiApp.tsx` currently only reads system theme in `useGateThemeClass`.

- [ ] **Step 3: Update `KordiApp.tsx` imports and gate theme hook**

Add imports:

```ts
import { readStoredThemeMode, resolveThemeMode } from '@/app/themePreference';
import type { ResolvedThemeMode, ThemeMode } from '@/kordi-app/types';
```

Remove the old `type { ResolvedThemeMode }` import if duplicated.

Replace `useGateThemeClass` with:

```ts
function useGateThemeClass() {
  const [themeMode] = useState<ThemeMode>(() => readStoredThemeMode());
  const [theme, setTheme] = useState<ResolvedThemeMode>(() => resolveThemeMode(themeMode, readSystemTheme()));

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mediaQuery = window.matchMedia('(prefers-color-scheme: light)');
    const handle = () => setTheme(resolveThemeMode(themeMode, mediaQuery.matches ? 'light' : 'dark'));
    handle();
    mediaQuery.addEventListener('change', handle);
    return () => mediaQuery.removeEventListener('change', handle);
  }, [themeMode]);

  useEffect(() => {
    document.body.classList.toggle('theme-light', theme === 'light');
    document.body.classList.toggle('theme-dark', theme === 'dark');
    document.documentElement.style.colorScheme = theme;
  }, [theme]);

  return theme;
}
```

- [ ] **Step 4: Run Cloud edition tests**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/cloudEdition.test.tsx tests/themePreference.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/desktop/src/KordiApp.tsx app/desktop/tests/cloudEdition.test.tsx
git commit -m "Respect persisted theme on cloud gate"
```

---

### Task 4: Strengthen active session hierarchy and quiet inactive rows

**Files:**
- Modify: `app/desktop/src/styles/shell.css`
- Modify: `app/desktop/src/styles/shell-sidebar.css`
- Modify: `app/desktop/src/styles/theme-overrides.css`
- Modify: `app/desktop/tests/themeTokens.test.tsx`
- Modify: `app/desktop/tests/workspaceSidebarParticipantSpaces.test.tsx`

- [ ] **Step 1: Update CSS regression tests for row hierarchy**

In `app/desktop/tests/themeTokens.test.tsx`, replace the active row assertion in `chat sidebar timestamps use the tertiary text token` with:

```ts
assert.match(shellCss, /\.app-session-meta-time\s*{[^}]*color:\s*var\(--utility-meta-text\)[^}]*letter-spacing:\s*0/s);
assert.match(shellCss, /\.app-session-meta-time-active\s*{[^}]*color:\s*color-mix\(in oklab, var\(--utility-foreground\) 84%, var\(--utility-muted-text\)\)/s);
assert.match(shellCss, /\.app-session-row\s*{[^}]*background:\s*transparent;[^}]*box-shadow:\s*none/s);
assert.match(shellCss, /\.app-session-row-active\s*{[^}]*border-color:\s*color-mix\(in oklab, var\(--app-accent-ring\) 82%, var\(--utility-foreground\)\);[^}]*background:\s*color-mix\(in oklab, var\(--app-control-active\) 92%, var\(--app-control-bg\)\);[^}]*box-shadow:\s*0 12px 26px/s);
```

In `app/desktop/tests/workspaceSidebarParticipantSpaces.test.tsx`, update `participant-space row CSS separates the timestamp and actions while adding dense dividers` by replacing the action and active-row assertions with:

```ts
assert.match(shellCss, /\.app-participant-space-row-actions\s*{[^}]*opacity:\s*0;[^}]*pointer-events:\s*none/s);
assert.match(shellCss, /\.app-participant-space-inline-group:is\(:hover, :focus-within\) \.app-participant-space-row-actions,[\s\S]*?\.app-participant-space-inline-group-expanded \.app-participant-space-row-actions\s*{[^}]*opacity:\s*1;[^}]*pointer-events:\s*auto/s);
assert.match(shellCss, /\.app-workspace-sidebar \.app-session-row-active\s*{[^}]*border-color:\s*color-mix\(in oklab, var\(--app-accent-ring\) 82%, var\(--utility-foreground\)\);[^}]*background:\s*color-mix\(in oklab, var\(--app-control-active\) 94%, var\(--app-control-bg\)\);[^}]*box-shadow:\s*0 12px 28px/s);
assert.match(shellCss, /\.app-workspace-sidebar \.app-session-row-fork\s*{[^}]*font-weight:\s*500;[^}]*opacity:\s*0\.9/s);
assert.match(shellCss, /\.app-workspace-sidebar \.app-participant-space-session-row\.app-session-row-active\s*{[^}]*border:\s*1px solid color-mix\(in oklab, var\(--app-accent-ring\) 70%, transparent\);[^}]*box-shadow:\s*0 8px 18px/s);
assert.doesNotMatch(shellCss, /border-left:\s*(?:[2-9]|\d{2,})px/);
assert.doesNotMatch(shellCss, /border-right:\s*(?:[2-9]|\d{2,})px/);
```

- [ ] **Step 2: Run failing style tests**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/themeTokens.test.tsx tests/workspaceSidebarParticipantSpaces.test.tsx
```

Expected: FAIL because current CSS uses weak active row styling, visible actions at rest, active child rows with no shadow, and metadata letter spacing.

- [ ] **Step 3: Update base session row CSS in `shell.css`**

Replace `.app-session-meta-time`, `.app-session-meta-time-active`, `.app-session-row`, `.app-session-row-active` blocks with:

```css
.app-session-meta-time {
  color: var(--utility-meta-text);
  letter-spacing: 0;
}

.app-session-meta-time-active {
  color: color-mix(in oklab, var(--utility-foreground) 84%, var(--utility-muted-text));
}

.app-session-row {
  border: 1px solid transparent;
  border-radius: 16px;
  background: transparent;
  box-shadow: none;
  transition:
    background-color var(--app-motion-fast) var(--app-motion-ease),
    border-color var(--app-motion-fast) var(--app-motion-ease),
    box-shadow var(--app-motion-fast) var(--app-motion-ease),
    color var(--app-motion-fast) var(--app-motion-ease);
}

.app-session-row:hover {
  background: color-mix(in oklab, var(--app-control-hover) 58%, transparent);
}

.app-session-row-active {
  border-color: color-mix(in oklab, var(--app-accent-ring) 82%, var(--utility-foreground));
  background: color-mix(in oklab, var(--app-control-active) 92%, var(--app-control-bg));
  box-shadow:
    0 12px 26px color-mix(in oklab, var(--app-accent-ring) 18%, transparent),
    0 1px 0 color-mix(in oklab, var(--utility-foreground) 10%, transparent),
    inset 0 1px 0 rgba(255, 255, 255, 0.05);
}
```

- [ ] **Step 4: Update sidebar-specific CSS in `shell-sidebar.css`**

Change `.app-workspace-sidebar .app-session-row-active` to:

```css
.app-workspace-sidebar .app-session-row-active {
  border-color: color-mix(in oklab, var(--app-accent-ring) 82%, var(--utility-foreground));
  background: color-mix(in oklab, var(--app-control-active) 94%, var(--app-control-bg));
  box-shadow:
    0 12px 28px color-mix(in oklab, var(--app-accent-ring) 20%, transparent),
    0 2px 7px color-mix(in oklab, var(--utility-background) 24%, transparent),
    inset 0 1px 0 color-mix(in oklab, var(--utility-foreground) 8%, transparent);
}
```

Add fork demotion and active title helpers after the active block:

```css
.app-workspace-sidebar .app-session-row-fork {
  font-weight: 500;
  opacity: 0.9;
}

.app-workspace-sidebar .app-session-title-active,
.app-workspace-sidebar .app-participant-space-session-title-active {
  color: var(--utility-foreground);
  font-weight: 650;
}

.app-workspace-sidebar .app-session-title-inactive,
.app-workspace-sidebar .app-participant-space-session-title-inactive {
  color: color-mix(in oklab, var(--utility-foreground) 76%, var(--utility-muted-text));
  font-weight: 500;
}
```

Change `.app-participant-space-row-actions` to:

```css
.app-participant-space-row-actions {
  position: static;
  display: grid;
  grid-template-columns: repeat(3, 1.5rem);
  align-items: center;
  gap: 0.125rem;
  padding: 0.375rem 0.25rem 0 0;
  opacity: 0;
  pointer-events: none;
  transition: opacity 100ms var(--app-motion-ease);
}
```

Replace `.app-participant-space-inline-group:not(...` visibility with:

```css
.app-participant-space-inline-group:is(:hover, :focus-within) .app-participant-space-row-actions,
.app-participant-space-inline-group-expanded .app-participant-space-row-actions {
  opacity: 1;
  pointer-events: auto;
}
```

Change child-row base/active rules:

```css
.app-workspace-sidebar .app-participant-space-session-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) max-content;
  align-items: start;
  gap: 0.625rem;
  border: 1px solid transparent;
  border-radius: 10px;
  background: transparent;
  box-shadow: none;
}

.app-workspace-sidebar .app-participant-space-session-row.app-session-row-active {
  border: 1px solid color-mix(in oklab, var(--app-accent-ring) 70%, transparent);
  background: color-mix(in oklab, var(--app-control-active) 86%, var(--app-control-bg));
  box-shadow: 0 8px 18px color-mix(in oklab, var(--app-accent-ring) 16%, transparent);
}
```

- [ ] **Step 5: Update light theme override so active rows keep elevation**

In `app/desktop/src/styles/theme-overrides.css`, remove `.bridge-app.theme-light .app-workspace-sidebar .app-session-row-active` from the “box-shadow: none” selector list.

Replace the light active row override block with:

```css
.bridge-app.theme-light .app-session-row-active {
  border-color: oklch(0.64 0.075 82 / 0.34);
  background: oklch(0.91 0.042 82 / 0.82);
  box-shadow:
    0 12px 24px oklch(0.64 0.075 82 / 0.12),
    0 2px 7px rgba(73, 62, 54, 0.075),
    inset 0 1px 0 rgba(255, 255, 255, 0.62);
}
```

- [ ] **Step 6: Run style tests**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/themeTokens.test.tsx tests/workspaceSidebarParticipantSpaces.test.tsx
```

Expected: PASS after updating test expectations for the new hierarchy.

- [ ] **Step 7: Commit**

```bash
git add app/desktop/src/styles/shell.css app/desktop/src/styles/shell-sidebar.css app/desktop/src/styles/theme-overrides.css app/desktop/tests/themeTokens.test.tsx app/desktop/tests/workspaceSidebarParticipantSpaces.test.tsx
git commit -m "Strengthen cloud sidebar active row hierarchy"
```

---

### Task 5: Wire active/inactive title and metadata classes in sidebar rows

**Files:**
- Modify: `app/desktop/src/pages/WorkspaceSidebar.tsx`
- Modify: `app/desktop/tests/workspaceSidebarParticipantSpaces.test.tsx`

- [ ] **Step 1: Add source/markup tests for row class wiring**

Add to `app/desktop/tests/workspaceSidebarParticipantSpaces.test.tsx`:

```ts
test('WorkspaceSidebar marks active session titles and removes metadata tracking', () => {
  const source = readFileSync(new URL('../src/pages/WorkspaceSidebar.tsx', import.meta.url), 'utf8');

  assert.match(source, /app-session-title-active/);
  assert.match(source, /app-session-title-inactive/);
  assert.match(source, /app-participant-space-session-title-active/);
  assert.match(source, /app-participant-space-session-title-inactive/);
  assert.doesNotMatch(source, /app-session-meta-time[^\n]*tracking-\[0\.03em\]/);
});
```

- [ ] **Step 2: Run failing test**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/workspaceSidebarParticipantSpaces.test.tsx
```

Expected: FAIL because active/inactive title classes are not wired and time labels include `tracking-[0.03em]`.

- [ ] **Step 3: Update `SidebarSessionMetaColumn` time class**

Replace:

```tsx
<span className={cn('app-session-meta-time whitespace-nowrap text-right text-[10px] font-medium leading-none tabular-nums tracking-[0.03em]', active && 'app-session-meta-time-active')}>
```

with:

```tsx
<span className={cn('app-session-meta-time whitespace-nowrap text-right text-[10px] font-medium leading-none tabular-nums', active && 'app-session-meta-time-active')}>
```

- [ ] **Step 4: Update participant-space child title class**

Replace:

```tsx
<span className="app-participant-space-session-title min-w-0 flex-1 truncate text-[12px] font-medium" title={sessionRowTitle}>{sessionRowTitle}</span>
```

with:

```tsx
<span
  className={cn(
    'app-participant-space-session-title min-w-0 flex-1 truncate text-[12px]',
    isActive ? 'app-participant-space-session-title-active' : 'app-participant-space-session-title-inactive',
  )}
  title={sessionRowTitle}
>
  {sessionRowTitle}
</span>
```

- [ ] **Step 5: Update agent session row title and time classes**

Replace:

```tsx
<span className="min-w-0 flex-1 truncate text-[12px] font-semibold tracking-[-0.01em] text-slate-100" title={sessionRowTitle}>{sessionRowTitle}</span>
```

with:

```tsx
<span
  className={cn(
    'min-w-0 flex-1 truncate text-[12px] tracking-[-0.01em]',
    isActive ? 'app-session-title-active' : 'app-session-title-inactive',
  )}
  title={sessionRowTitle}
>
  {sessionRowTitle}
</span>
```

Replace:

```tsx
<span className={cn('app-session-meta-time whitespace-nowrap text-[10px] font-medium leading-none tabular-nums tracking-[0.03em] text-slate-400', isActive && 'app-session-meta-time-active')}>
```

with:

```tsx
<span className={cn('app-session-meta-time whitespace-nowrap text-[10px] font-medium leading-none tabular-nums', isActive && 'app-session-meta-time-active')}>
```

- [ ] **Step 6: Run sidebar tests**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/workspaceSidebarParticipantSpaces.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add app/desktop/src/pages/WorkspaceSidebar.tsx app/desktop/tests/workspaceSidebarParticipantSpaces.test.tsx
git commit -m "Demote inactive sidebar session rows"
```

---

### Task 6: Final focused verification

**Files:**
- All modified files.

- [ ] **Step 1: Run focused tests for #474**

Run:

```bash
pnpm --dir app/desktop exec tsx --test \
  tests/themePreference.test.ts \
  tests/useKordiLocalUiStateTheme.test.ts \
  tests/cloudEdition.test.tsx \
  tests/themeTokens.test.tsx \
  tests/workspaceSidebarParticipantSpaces.test.tsx \
  tests/cloudSettingsAvatarPopout.test.ts \
  tests/cloudSurfaceCleanup.test.ts
```

Expected: all tests pass.

- [ ] **Step 2: Run typecheck**

Run:

```bash
pnpm --dir app/desktop typecheck
```

Expected: PASS.

- [ ] **Step 3: Optional local visual QA for Cloud edition**

If manual verification is requested, launch exactly three instances from this worktree:

```bash
pnpm --dir app/desktop tauri:dev:multi:cloud -- --users user1,user2,user3
```

Verify:
- light theme inactive rows are transparent and active row is immediately identifiable
- dark theme relationship matches light theme
- action buttons appear only on hover/focus/active with no row width jump
- setting Theme → Dark survives restart/logout
- setting Theme → Auto follows system light/dark at gate and after login

- [ ] **Step 4: Commit verification note if a plan/spec file is tracked**

If this plan file is part of the branch, include it in the final branch commit or leave it as a planning-only artifact per project convention.
