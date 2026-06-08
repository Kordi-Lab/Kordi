# Issue 552 Loading/Login Theme Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Cloud login gate and loading/starting screen correctly follow light/dark theme tokens, and make the loading dots clean, flat, and less glowy.

**Architecture:** Fix the theme root first: `CloudGateShell` must put `theme-light` / `theme-dark` on the same `.bridge-app` element that scopes `theme-tokens.css`. Then keep login/loading styles token-driven and flatten only the starting dots, preserving the minimal no-copy loading surface already requested by earlier tests.

**Tech Stack:** React 19, Tauri desktop shell, Tailwind utility classes, scoped CSS tokens in `app/desktop/src/styles/theme-tokens.css` and `theme-overrides.css`, Node `tsx --test` regression tests.

---

## Debug / Review Summary

Root cause found before implementation:

- `app/desktop/src/KordiApp.tsx` has `useGateThemeClass()`, which reads the stored theme and toggles `theme-light` / `theme-dark` on `<body>` while login/loading gates are visible.
- The actual tokens are scoped as `.bridge-app.theme-light { ... }` in `app/desktop/src/styles/theme-tokens.css`.
- `CloudGateShell` renders `<div className="bridge-app app-cloud-login-shell">` without a theme class, so the login and session-restore loading gate stay on the base dark `.bridge-app` tokens even when body has `theme-light`.
- `KordiAppShell` already renders initial sync loading with `<div className={`bridge-app ${appShellFrameProps.rootThemeClass}`}>`, so the main-shell initial-sync path is less likely to be broken. The pre-shell CloudGateShell path is the failing path.
- Loading indicator CSS in `app/desktop/src/styles/theme-overrides.css` uses `filter: drop-shadow(...)`, `::before` halo blobs, larger 13px dots, and radial highlights, matching the heavy/glowy screenshot.

Baseline verification already run in the worktree:

```bash
pnpm install --frozen-lockfile
pnpm --dir app/desktop typecheck
pnpm --dir app/desktop exec tsx --test tests/cloudEdition.test.tsx
```

All focused cloud tests passed before changes.

---

## File Structure

- Modify: `app/desktop/src/KordiApp.tsx`
  - Return the resolved gate theme from `useGateThemeClass()`.
  - Apply `theme-${theme}` on the `.bridge-app.app-cloud-login-shell` root.
- Modify: `app/desktop/tests/cloudEdition.test.tsx`
  - Add SSR tests that prove stored light/dark theme resolves onto the CloudGateShell `.bridge-app` root for signed-out login and session-restore loading.
  - Add CSS regression for flat loading dots.
- Modify: `app/desktop/src/styles/theme-overrides.css`
  - Flatten the starting dots: no drop shadow, no pseudo halo, no radial-gradient highlight; smaller circular dots with subtle opacity/translate animation.
  - Keep theme-specific dot color variables and reduced-motion behavior.
- Optional modify: `app/desktop/tests/themeTokens.test.tsx`
  - Only if the CSS regression reads better in theme-token tests; prefer keeping Cloud gate tests in `cloudEdition.test.tsx`.

---

### Task 1: Apply the resolved theme class to the Cloud gate root

**Files:**
- Modify: `app/desktop/src/KordiApp.tsx`
- Test: `app/desktop/tests/cloudEdition.test.tsx`

- [ ] **Step 1: Write failing tests for gate root theme classes**

Add this import near the other imports in `app/desktop/tests/cloudEdition.test.tsx`:

```ts
import { KORDI_THEME_MODE_STORAGE_KEY } from '../src/app/themePreference';
```

Add this helper after `withLocalStorage(...)`:

```ts
function withWindowTheme<T>({
  storedTheme,
  systemPrefersLight = false,
}: {
  storedTheme: 'light' | 'dark' | 'auto';
  systemPrefersLight?: boolean;
}, run: () => T): T {
  const storage = makeStorageStub({ [KORDI_THEME_MODE_STORAGE_KEY]: storedTheme });
  const target = globalThis as typeof globalThis & { window?: Window & typeof globalThis };
  const previousWindow = target.window;
  target.window = {
    localStorage: storage,
    matchMedia: () => ({
      matches: systemPrefersLight,
      media: '(prefers-color-scheme: light)',
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  } as Window & typeof globalThis;
  try {
    return run();
  } finally {
    if (previousWindow) target.window = previousWindow;
    else delete target.window;
  }
}
```

Add these tests near the existing `cloud login gate reads persisted theme preference before shell mount` test:

```ts
test('cloud login gate applies stored light theme on the bridge-app root', () => {
  const markup = withWindowTheme({ storedTheme: 'light' }, () => renderToStaticMarkup(createElement(KordiAppRoot, {
    cloudSessionStatus: 'signed-out',
  })));

  assert.match(markup, /class="bridge-app app-cloud-login-shell theme-light"/);
  assert.doesNotMatch(markup, /class="bridge-app app-cloud-login-shell"/);
});

test('cloud session restore gate applies stored dark theme on the bridge-app root', () => {
  const markup = withWindowTheme({ storedTheme: 'dark' }, () => renderToStaticMarkup(createElement(KordiAppRoot, {
    cloudSessionStatus: 'loading',
    cloudSession: {
      status: 'loading',
      account: null,
      signIn: async () => {},
      signUp: async () => {},
      signInWithProvider: async () => {},
    },
  })));

  assert.match(markup, /class="bridge-app app-cloud-login-shell theme-dark"/);
  assert.match(markup, /app-cloud-starting-screen/);
});

test('cloud gate auto theme follows system light before shell mount', () => {
  const markup = withWindowTheme({ storedTheme: 'auto', systemPrefersLight: true }, () => renderToStaticMarkup(createElement(KordiAppRoot, {
    cloudSessionStatus: 'signed-out',
  })));

  assert.match(markup, /class="bridge-app app-cloud-login-shell theme-light"/);
});
```

- [ ] **Step 2: Run the tests to verify failure**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/cloudEdition.test.tsx
```

Expected: the new tests fail because `CloudGateShell` currently renders `class="bridge-app app-cloud-login-shell"` without `theme-light` or `theme-dark`.

- [ ] **Step 3: Apply the minimal implementation**

In `app/desktop/src/KordiApp.tsx`, replace `CloudGateShell` with:

```tsx
function CloudGateShell({ children }: { children: React.ReactNode }) {
  const theme = useGateThemeClass();
  return (
    <div className={`bridge-app app-cloud-login-shell theme-${theme}`}>
      {children}
    </div>
  );
}
```

Do not remove the body-class side effect in `useGateThemeClass()`; it still keeps `body` and `documentElement.style.colorScheme` aligned while the shell is not mounted.

- [ ] **Step 4: Run the focused tests**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/cloudEdition.test.tsx
```

Expected: all cloud edition tests pass, including the new root-theme tests.

- [ ] **Step 5: Commit**

```bash
git add app/desktop/src/KordiApp.tsx app/desktop/tests/cloudEdition.test.tsx
git commit -m "fix: apply theme class to cloud gate root"
```

---

### Task 2: Flatten and quiet the Cloud starting dots

**Files:**
- Modify: `app/desktop/src/styles/theme-overrides.css`
- Test: `app/desktop/tests/cloudEdition.test.tsx`

- [ ] **Step 1: Write failing CSS regression tests for flat dots**

Add this helper near `readSource(...)` in `app/desktop/tests/cloudEdition.test.tsx`:

```ts
function cssBlock(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`${escaped}\\s*\\{[\\s\\S]*?\\n\\}`))?.[0] ?? '';
}
```

Add this test near the existing starting-screen tests:

```ts
test('cloud starting dots are flat and non-glowy in CSS', () => {
  const css = readSource('src/styles/theme-overrides.css');
  const dotBlock = cssBlock(css, '.app-cloud-starting-dot');

  assert.match(dotBlock, /width:\s*9px/);
  assert.match(dotBlock, /height:\s*9px/);
  assert.match(dotBlock, /border-radius:\s*999px/);
  assert.match(dotBlock, /background:\s*currentColor/);
  assert.doesNotMatch(dotBlock, /filter:|drop-shadow|box-shadow/);
  assert.doesNotMatch(css, /\.app-cloud-starting-dot::before/);
  assert.doesNotMatch(css, /\.app-cloud-starting-dot-[123]\s*\{[\s\S]*?radial-gradient/);
});
```

- [ ] **Step 2: Run the test to verify failure**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/cloudEdition.test.tsx
```

Expected: the new CSS test fails because the current dot block has 13px dots, `filter: drop-shadow(...)`, a `::before` halo, and radial-gradient highlights.

- [ ] **Step 3: Replace the starting dot CSS with a flatter version**

In `app/desktop/src/styles/theme-overrides.css`, replace the `.app-cloud-starting-screen` variable block through the reduced-motion block for `.app-cloud-starting-dot` with this CSS:

```css
.app-cloud-starting-screen {
  --app-cloud-starting-dot-a: oklch(0.72 0.11 212 / 0.72);
  --app-cloud-starting-dot-b: oklch(0.74 0.10 165 / 0.70);
  --app-cloud-starting-dot-c: oklch(0.76 0.11 78 / 0.68);
  --app-cloud-starting-retry-bg: oklch(1 0 0 / 0.06);
  --app-cloud-starting-retry-border: oklch(1 0 0 / 0.12);
  --app-cloud-starting-retry-text: var(--utility-secondary-text);
  position: fixed;
  inset: 0;
  z-index: 100;
  display: grid;
  place-items: center;
  background: var(--app-cloud-login-page-bg);
  color: var(--utility-foreground);
}

.bridge-app .app-cloud-starting-screen {
  --app-cloud-login-page-bg:
    radial-gradient(circle at top left, rgba(132, 122, 196, 0.08), transparent 36%),
    radial-gradient(circle at 86% 12%, rgba(132, 199, 196, 0.05), transparent 30%),
    linear-gradient(180deg, #0f1115 0%, #0d0f13 52%, #090b0f 100%);
}

.bridge-app.theme-light .app-cloud-starting-screen {
  --app-cloud-login-page-bg: oklch(0.955 0.026 82);
  --app-cloud-starting-dot-a: oklch(0.58 0.12 212 / 0.70);
  --app-cloud-starting-dot-b: oklch(0.54 0.11 165 / 0.66);
  --app-cloud-starting-dot-c: oklch(0.62 0.12 78 / 0.68);
  --app-cloud-starting-retry-bg: oklch(1 0 0 / 0.52);
  --app-cloud-starting-retry-border: oklch(0.62 0.05 82 / 0.22);
  --app-cloud-starting-retry-text: oklch(0.34 0.035 125);
}

.app-cloud-starting-dots {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 11px;
}

.app-cloud-starting-dot {
  width: 9px;
  height: 9px;
  border-radius: 999px;
  background: currentColor;
  opacity: 0.68;
  transform-origin: center;
  animation: app-cloud-starting-pulse 1.35s var(--app-motion-ease) infinite;
}

.app-cloud-starting-dot-1 {
  color: var(--app-cloud-starting-dot-a);
  animation-delay: 0ms;
}

.app-cloud-starting-dot-2 {
  color: var(--app-cloud-starting-dot-b);
  animation-delay: 120ms;
}

.app-cloud-starting-dot-3 {
  color: var(--app-cloud-starting-dot-c);
  animation-delay: 240ms;
}

.app-cloud-starting-retry {
  position: absolute;
  top: calc(50% + 34px);
  left: 50%;
  transform: translateX(-50%);
  border: 1px solid var(--app-cloud-starting-retry-border);
  border-radius: 999px;
  background: var(--app-cloud-starting-retry-bg);
  color: var(--app-cloud-starting-retry-text);
  padding: 7px 14px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
}

.app-cloud-starting-retry:hover {
  color: var(--utility-foreground);
}

@keyframes app-cloud-starting-pulse {
  0%, 100% {
    transform: translateY(0) scale(0.94);
    opacity: 0.46;
  }
  45% {
    transform: translateY(-2px) scale(1);
    opacity: 0.82;
  }
}

@media (prefers-reduced-motion: reduce) {
  .app-cloud-starting-dot {
    animation: none;
  }
}
```

Important: preserve the existing selectors immediately before and after this block (`.app-cloud-login-submit:hover:not(:disabled)` before, `@layer utilities` after). Remove the old `--app-cloud-starting-shadow`, `filter`, `.app-cloud-starting-dot::before`, radial-gradient dot backgrounds, and `@keyframes app-cloud-starting-drift`.

- [ ] **Step 4: Run focused CSS/markup tests**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/cloudEdition.test.tsx
```

Expected: all cloud edition tests pass; the starting screen still renders exactly three dots and no visible copy/retry button.

- [ ] **Step 5: Commit**

```bash
git add app/desktop/src/styles/theme-overrides.css app/desktop/tests/cloudEdition.test.tsx
git commit -m "style: flatten cloud loading dots"
```

---

### Task 3: Verify theme-token coverage and full desktop safety

**Files:**
- Test-only unless failures reveal an implementation gap.

- [ ] **Step 1: Run theme token regression tests**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/themeTokens.test.tsx
```

Expected: pass. If it fails because loader/login theme coverage belongs there, add only focused assertions for the Cloud login/loading CSS token selectors; do not duplicate all `cloudEdition.test.tsx` checks.

- [ ] **Step 2: Run focused Cloud tests again**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/cloudEdition.test.tsx
```

Expected: pass.

- [ ] **Step 3: Run desktop typecheck**

Run:

```bash
pnpm --dir app/desktop typecheck
```

Expected: pass.

- [ ] **Step 4: Manual preview validation**

Launch the local Cloud Desktop preview from this worktree using the user’s preferred cloud API base:

```bash
VITE_KORDI_CLOUD_API_BASE="https://korde-product-cloud.35.188.85.31.sslip.io" pnpm --dir app/desktop tauri dev
```

Manual checks:

1. Set/persist light theme, sign out or clear session, relaunch.
2. Confirm login page is visibly light and cohesive with the light shell palette.
3. Confirm session-restore loading screen is light when the stored/system theme is light.
4. Confirm dark mode still renders dark, but not disconnected from app tokens.
5. Confirm loader dots are smaller/flatter, no halo/glow, subtle motion, reduced-motion disables animation.
6. Confirm login controls, titlebar drag strip, Google/GitHub buttons, email/password fields, and signup avatar upload still work.

- [ ] **Step 5: Commit verification-only adjustments if any**

If Task 3 required small test/CSS corrections, commit them:

```bash
git add app/desktop/src app/desktop/tests
git commit -m "test: cover cloud gate theme styling"
```

If no changes were needed, do not create an empty commit.

---

## Final Verification Checklist

Run before opening the PR:

```bash
pnpm --dir app/desktop exec tsx --test tests/cloudEdition.test.tsx
pnpm --dir app/desktop exec tsx --test tests/themeTokens.test.tsx
pnpm --dir app/desktop typecheck
```

Expected final state:

- Login gate root markup includes `bridge-app app-cloud-login-shell theme-light` or `theme-dark` before the main shell mounts.
- Loading/session-restore gate root uses the same theme class path.
- Light theme login/loading use `.bridge-app.theme-light` token overrides.
- Starting dots remain three accessible-hidden dots, but CSS is flat/no-glow.
- Existing no-copy loading tests remain passing.
