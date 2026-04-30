# Sender Bubble Shape Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the selected A2 clean squared soft-tail shape for human chat bubbles and queued outgoing messages.

**Architecture:** Add a small shape helper module that exposes semantic class names and a shared SVG backdrop for transcript and queued bubbles. Replace hardcoded radius utilities in `MessageBubbleView` and `QueuedMessageBubble` with those classes, and render the actual A2 geometry as one continuous filled/stroked vector path with CSS-owned theme variables and motion.

**Tech Stack:** React, TypeScript, Tailwind utility classes, CSS custom properties, Node test runner.

---

## File Structure

- Create `app/desktop/src/features/chat/messageBubbleShape.tsx` for reusable semantic shape classes and the seamless SVG backdrop.
- Create `app/desktop/tests/messageBubbleShape.test.tsx` for focused regression coverage of selected classes.
- Modify `app/desktop/src/kordi-app/components/transcript.tsx` to use semantic shape classes for outgoing and peer human bubbles.
- Modify `app/desktop/src/pages/ChatsPage.tsx` to use the queued outgoing shape class.
- Modify `app/desktop/src/styles/shell.css` to define A2 clean squared soft-tail fill/stroke variables, shape positioning, and subtle reduced-motion-safe entrance motion.

## Task 1: Add semantic shape class helper

**Files:**
- Create: `app/desktop/src/features/chat/messageBubbleShape.tsx`
- Test: `app/desktop/tests/messageBubbleShape.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `app/desktop/tests/messageBubbleShape.test.tsx`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  humanMessageBubbleShapeClass,
  queuedMessageBubbleShapeClass,
} from '../src/features/chat/messageBubbleShape';

test('human message bubble shape classes encode the selected clean squared soft-tail direction', () => {
  assert.equal(humanMessageBubbleShapeClass('own'), 'app-message-bubble app-message-bubble-own');
  assert.equal(humanMessageBubbleShapeClass('peer'), 'app-message-bubble app-message-bubble-peer');
});

test('queued message bubble shape uses the outgoing clean squared soft-tail class', () => {
  assert.equal(
    queuedMessageBubbleShapeClass,
    'app-message-bubble app-message-bubble-own app-message-bubble-queued',
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm --dir app/desktop test:unit -- messageBubbleShape.test.tsx
```

Expected: FAIL because `../src/features/chat/messageBubbleShape` does not exist yet.

- [ ] **Step 3: Write minimal implementation**

Create `app/desktop/src/features/chat/messageBubbleShape.tsx`:

```ts
export type HumanMessageBubbleSide = 'own' | 'peer';

export function humanMessageBubbleShapeClass(side: HumanMessageBubbleSide) {
  return `app-message-bubble app-message-bubble-${side}`;
}

export const queuedMessageBubbleShapeClass = `${humanMessageBubbleShapeClass('own')} app-message-bubble-queued`;
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
pnpm --dir app/desktop test:unit -- messageBubbleShape.test.tsx
```

Expected: PASS.

## Task 2: Apply shape classes and CSS geometry

**Files:**
- Modify: `app/desktop/src/kordi-app/components/transcript.tsx`
- Modify: `app/desktop/src/pages/ChatsPage.tsx`
- Modify: `app/desktop/src/styles/shell.css`
- Test: `app/desktop/tests/messageBubbleShape.test.tsx`

- [ ] **Step 1: Extend the test to guard against old rounded utilities returning**

Append to `app/desktop/tests/messageBubbleShape.test.tsx`:

```ts
import { readFileSync } from 'node:fs';

test('transcript and queued bubbles no longer hardcode the old pill radius utilities', () => {
  const transcript = readFileSync(new URL('../src/kordi-app/components/transcript.tsx', import.meta.url), 'utf8');
  const chatsPage = readFileSync(new URL('../src/pages/ChatsPage.tsx', import.meta.url), 'utf8');

  assert.match(transcript, /humanMessageBubbleShapeClass\('own'\)/);
  assert.match(transcript, /humanMessageBubbleShapeClass\('peer'\)/);
  assert.match(chatsPage, /queuedMessageBubbleShapeClass/);
  assert.doesNotMatch(transcript, /rounded-\[20px\] rounded-br-\[6px\]/);
  assert.doesNotMatch(transcript, /rounded-\[20px\] rounded-bl-\[6px\]/);
  assert.doesNotMatch(chatsPage, /rounded-\[19px\] rounded-br-\[6px\]/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm --dir app/desktop test:unit -- messageBubbleShape.test.tsx
```

Expected: FAIL because the components still hardcode the old rounded utilities.

- [ ] **Step 3: Import and use the shape helper**

In `app/desktop/src/kordi-app/components/transcript.tsx`, add:

```ts
import { humanMessageBubbleShapeClass } from '@/features/chat/messageBubbleShape';
```

Replace outgoing and peer human shape class fragments with:

```ts
? cn('w-fit max-w-[26rem] px-3 py-2', humanMessageBubbleShapeClass('own'))
: isPeerHumanMessage
  ? cn('w-fit max-w-[26rem] px-3 py-2', humanMessageBubbleShapeClass('peer'))
```

In `app/desktop/src/pages/ChatsPage.tsx`, add:

```ts
import { queuedMessageBubbleShapeClass } from '@/features/chat/messageBubbleShape';
```

Replace the queued bubble class shape fragment with:

```tsx
className={cn('app-queued-message max-w-[min(72%,34rem)] px-3 py-2 text-right', queuedMessageBubbleShapeClass)}
```

- [ ] **Step 4: Add seamless vector geometry**

In `messageBubbleShape.tsx`, add `MessageBubbleShapeBackdrop` and a path helper that renders one mirrored SVG `<path>` per side. The path should use fixed-radius/fixed-tail geometry based on measured bubble size so long messages do not stretch the tail. In `shell.css`, make human and queued bubbles transparent containers, set `--app-message-bubble-fill` / `--app-message-bubble-stroke` variables, position `.app-message-bubble-shape` behind content, and add a subtle transform/opacity entrance animation with a reduced-motion override.

- [ ] **Step 5: Run tests**

Run:

```bash
pnpm --dir app/desktop test:unit -- messageBubbleShape.test.tsx
pnpm --dir app/desktop typecheck
pnpm --dir app/desktop lint
```

Expected: all pass.

## Task 3: Preview and final verification

**Files:**
- No source changes expected unless preview reveals issues.

- [ ] **Step 1: Launch a preserved local preview instance**

Use the multi-instance launcher with existing user data, no reset, pointing logs/runtime at this worktree.

- [ ] **Step 2: User preview gate**

Ask the user to inspect the running instance before opening a PR.

- [ ] **Step 3: Full verification before PR**

Run:

```bash
pnpm --dir app/desktop test:unit
pnpm --dir app/desktop typecheck
pnpm --dir app/desktop lint
pnpm --dir app/desktop build
cargo test -p kordi-desktop --no-default-features
git diff --check
```

Expected: all pass, except the existing Vite large-chunk warning may remain.

## Plan Self-Review

- Spec coverage: outgoing human, peer human, queued outgoing, unchanged agent/tool/system scope, and preview gate are covered.
- Placeholder scan: no TBD/TODO placeholders remain.
- Type consistency: `humanMessageBubbleShapeClass` and `queuedMessageBubbleShapeClass` are used consistently across tests and implementation steps.
