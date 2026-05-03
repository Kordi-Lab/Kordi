# IME Composer Enter Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent chat and project composers from sending messages when Enter is used to confirm Chinese Pinyin or other IME composition input.

**Architecture:** Add one focused shared composer IME guard in `src/features/chat/imeComposition.ts`, with pure detection helpers plus a small React hook for delayed composition clearing. Wire both chat and project textareas through the hook so all composer shortcuts ignore IME key events before they handle Enter, Tab, arrows, or Escape.

**Tech Stack:** React 19, TypeScript, Node test runner, Tauri desktop webview.

---

### Task 1: Add regression tests for IME key detection

**Files:**
- Create: `app/desktop/tests/imeComposition.test.tsx`
- Create later: `app/desktop/src/features/chat/imeComposition.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { isImeCompositionKeyDown } from '../src/features/chat/imeComposition';

test('IME guard ignores Enter while browser reports native composition', () => {
  assert.equal(isImeCompositionKeyDown({ nativeEvent: { isComposing: true } }, false), true);
});

test('IME guard ignores Safari-style Enter while local composition state is still active', () => {
  assert.equal(isImeCompositionKeyDown({ key: 'Enter', nativeEvent: { isComposing: false } }, true), true);
});

test('IME guard ignores process key events with keyCode 229', () => {
  assert.equal(isImeCompositionKeyDown({ nativeEvent: { keyCode: 229 } }, false), true);
});

test('IME guard allows normal Enter after composition is clear', () => {
  assert.equal(isImeCompositionKeyDown({ key: 'Enter', nativeEvent: { isComposing: false, keyCode: 13 } }, false), false);
});
```

- [ ] **Step 2: Run tests to verify RED**

Run: `pnpm --dir app/desktop test:unit -- imeComposition.test.tsx`

Expected: FAIL because `../src/features/chat/imeComposition` does not exist.

- [ ] **Step 3: Implement pure detection helper**

Create `app/desktop/src/features/chat/imeComposition.ts` with `isImeCompositionKeyDown(event, isCompositionActive)` that returns true for active local composition, native `isComposing`, or native/top-level keyCode/which `229`.

- [ ] **Step 4: Run tests to verify GREEN**

Run: `pnpm --dir app/desktop test:unit -- imeComposition.test.tsx`

Expected: PASS for all IME guard tests.

- [ ] **Step 5: Commit**

```bash
git add app/desktop/tests/imeComposition.test.tsx app/desktop/src/features/chat/imeComposition.ts
git commit -m "Add IME composer key guard tests"
```

### Task 2: Add delayed composition lifecycle hook

**Files:**
- Modify: `app/desktop/src/features/chat/imeComposition.ts`
- Modify: `app/desktop/tests/imeComposition.test.tsx`

- [ ] **Step 1: Write the failing lifecycle test**

Add a test with a fake scheduler showing `createImeCompositionState()` starts active on composition start, stays active immediately after composition end, and clears only when the scheduled callback runs.

- [ ] **Step 2: Run test to verify RED**

Run: `pnpm --dir app/desktop test:unit -- imeComposition.test.tsx`

Expected: FAIL because `createImeCompositionState` is not exported.

- [ ] **Step 3: Implement lifecycle state and React hook**

Add `createImeCompositionState({ schedule, cancel })` and `useImeCompositionGuard()`. The hook should use `window.setTimeout(..., 0)` on composition end and cancel pending clears on composition start or unmount.

- [ ] **Step 4: Run test to verify GREEN**

Run: `pnpm --dir app/desktop test:unit -- imeComposition.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/desktop/tests/imeComposition.test.tsx app/desktop/src/features/chat/imeComposition.ts
git commit -m "Track IME composition state for composers"
```

### Task 3: Wire chat and project composers

**Files:**
- Modify: `app/desktop/src/pages/ChatsPage.tsx`
- Modify: `app/desktop/src/pages/ProjectsPage.tsx`

- [ ] **Step 1: Add composer guards**

Import `useImeCompositionGuard`, instantiate one guard in each page component, and add `onCompositionStart` / `onCompositionEnd` to the textarea.

- [ ] **Step 2: Guard keyboard shortcuts before composer menu/send logic**

At the start of each textarea `onKeyDown`, call `if (imeCompositionGuard.isComposingKeyDown(event)) return;`. This preserves browser IME confirmation and prevents Kordi from accepting slash/mention items or sending messages during composition.

- [ ] **Step 3: Run targeted tests**

Run: `pnpm --dir app/desktop test:unit -- imeComposition.test.tsx`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add app/desktop/src/pages/ChatsPage.tsx app/desktop/src/pages/ProjectsPage.tsx
git commit -m "Guard composer shortcuts during IME input"
```

### Task 4: Verify and open PR

**Files:**
- No further code changes expected.

- [ ] **Step 1: Run full verification**

Run:

```bash
pnpm --dir app/desktop test:unit
pnpm --dir app/desktop typecheck
pnpm --dir app/desktop lint
pnpm --dir app/desktop build
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 2: Manual QA note**

Record that manual desktop validation should use macOS Chinese Pinyin: type `nihao`, press Enter to commit `你好`, then press Enter again to send.

- [ ] **Step 3: Open PR**

Use PR title `Fix IME Enter composer submission` and include `Closes #216` plus the verification output summary.
