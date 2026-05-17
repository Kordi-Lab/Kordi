# Provider Setup Launch Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the first-run provider setup gate with a focused, single-column launch surface that removes forced uppercase microcopy and makes provider selection the primary action.

**Architecture:** Keep the existing auth routing and detail pages intact. Only change the gate/list presentation: `AuthPage` becomes the launch-shell owner, `AuthProviderList` renders a compact two-column provider grid in gate mode while retaining the existing list behavior for Settings.

**Tech Stack:** React 19, TypeScript, Tailwind utility classes, Node `tsx --test`, desktop TypeScript typecheck.

---

## File Structure

- Modify `app/desktop/src/kordi-app/auth/AuthPage.tsx`
  - Remove split onboarding panel for gate mode.
  - Render a centered, single-column launch surface with concise headline/subtitle and muted shared-auth footer.
  - Pass a new `variant` prop to `AuthProviderList` so gate mode can use cards while settings mode keeps rows.
- Modify `app/desktop/src/kordi-app/auth/AuthProviderList.tsx`
  - Add `variant?: 'settings' | 'gate'` prop.
  - In gate mode, remove uppercase count pill, long provider explanations, row dividers, and heavy settings-list chrome.
  - Render providers as a responsive two-column card grid with short subtitles.
- Add `app/desktop/tests/authLaunchSurface.test.ts`
  - Static source tests to lock the UI direction: no split hero grid, no forced uppercase provider count, concise copy, card-grid classes, and shared auth path hidden from the primary gate.

---

### Task 1: Lock the launch-surface direction with failing tests

**Files:**
- Create: `app/desktop/tests/authLaunchSurface.test.ts`

- [ ] **Step 1: Write the failing test**

Create `app/desktop/tests/authLaunchSurface.test.ts` with:

```ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function readAuthSource(relativePath: string): string {
  return readFileSync(new URL(`../src/kordi-app/auth/${relativePath}`, import.meta.url), 'utf8');
}

test('provider gate is a focused single-column launch surface', () => {
  const authPage = readAuthSource('AuthPage.tsx');

  assert.match(authPage, /Connect a provider/);
  assert.match(authPage, /Use cloud APIs or local models to start chatting\./);
  assert.doesNotMatch(authPage, /Connect one provider before your first chat\./);
  assert.doesNotMatch(authPage, /grid-cols-\[minmax\(320px,0\.86fr\)_minmax\(460px,1\.08fr\)\]/);
  assert.doesNotMatch(authPage, /Shared sign-in store/);
  assert.match(authPage, /Shared authentication enabled/);
});

test('gate provider picker uses cards without forced uppercase microcopy', () => {
  const providerList = readAuthSource('AuthProviderList.tsx');

  assert.match(providerList, /variant\?: 'settings' \| 'gate'/);
  assert.match(providerList, /grid-cols-\[repeat\(2,minmax\(0,1fr\)\)\]/);
  assert.match(providerList, /ChatGPT & API/);
  assert.match(providerList, /Claude & API/);
  assert.doesNotMatch(providerList, /\buppercase\b/);
  assert.doesNotMatch(providerList, /saved of/);
  assert.doesNotMatch(providerList, /provider\.loginHint/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/authLaunchSurface.test.ts
```

Expected: FAIL because current gate still uses split layout, long copy, uppercase count pill, and row list.

- [ ] **Step 3: Commit the failing test**

Do not commit red test alone unless explicitly pausing. Proceed to Task 2.

---

### Task 2: Implement focused gate layout and provider card grid

**Files:**
- Modify: `app/desktop/src/kordi-app/auth/AuthPage.tsx`
- Modify: `app/desktop/src/kordi-app/auth/AuthProviderList.tsx`
- Test: `app/desktop/tests/authLaunchSurface.test.ts`

- [ ] **Step 1: Update `AuthProviderList` API and short subtitles**

Add `variant?: 'settings' | 'gate'` to props. Add a `gateProviderSubtitle(provider)` helper returning:

```ts
const GATE_PROVIDER_SUBTITLES: Record<string, string> = {
  openai: 'ChatGPT & API',
  anthropic: 'Claude & API',
  'lm-studio': 'Local models',
  ollama: 'Local models',
  'google-gemini': 'Gemini API',
  groq: 'Fast inference',
  openrouter: 'Model router',
  'github-copilot': 'Copilot account',
  xai: 'Grok API',
};
```

If provider is configured, return `Ready to chat`; otherwise return map value or `Cloud API`.

- [ ] **Step 2: Render card grid for gate variant**

In `AuthProviderList`, before the settings-list return, add a gate branch:

```tsx
if (variant === 'gate') {
  return (
    <div className="flex min-h-0 w-full flex-col gap-4" style={{ WebkitAppRegion: 'no-drag' as const }}>
      {configuredCount > 0 ? (...success banner...) : null}
      <div className="grid min-h-0 grid-cols-[repeat(2,minmax(0,1fr))] gap-3">
        {providers.map((provider) => (...card button...))}
      </div>
    </div>
  );
}
```

Each card should be compact:

- icon on the left
- provider label
- `gateProviderSubtitle(provider)`
- small `Ready` chip only when configured
- no `provider.loginHint`
- no row separators
- no `uppercase`

- [ ] **Step 3: Update `AuthPage` gate branch**

Replace the split hero layout with one centered launch panel:

- outer `app-modal-panel` remains
- inner layout is single column, centered max width
- headline: `Connect a provider`
- subtitle: `Use cloud APIs or local models to start chatting.`
- render `AuthProviderList variant="gate"`
- footer line: `Shared authentication enabled`
- optional skip button text: `Skip for now →`
- do not show `sharedAuthPathPreview` on the primary gate surface

- [ ] **Step 4: Run focused test**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/authLaunchSurface.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run typecheck**

Run:

```bash
pnpm --dir app/desktop typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit implementation**

```bash
git add app/desktop/src/kordi-app/auth/AuthPage.tsx app/desktop/src/kordi-app/auth/AuthProviderList.tsx app/desktop/tests/authLaunchSurface.test.ts
git commit -m "Redesign provider setup as launch surface"
```

---

## Self-Review

- Issue #464 asks for single-column focus layout: Task 2 Step 3 implements this.
- It asks for reduced explanatory text: headline/subtitle and card subtitles are concise.
- It asks for card grid instead of settings rows: Task 2 Step 2 implements gate-only grid.
- It asks to demote shared auth path: Task 2 Step 3 replaces it with footer text and hides path.
- It asks to remove uppercase-heavy UI: Task 1 locks no `uppercase` in provider list and copy avoids capitals.
- Settings behavior remains intact because the existing settings list is preserved for `variant !== 'gate'`.
