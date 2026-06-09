# Message Drag Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add drag-across-check-controls selection for the existing multi-select forward mode.

**Architecture:** Add a pure `messageSelection` helper for selection state transitions, wire drag pointer callbacks through `MessageBubble`, and use refs in `useKordiAppModel` to track the active drag gesture without extra render state.

**Tech Stack:** React, TypeScript, Node test runner, React server rendering tests, existing Kordi desktop app CSS/theme tokens.

---

## File structure

- Create `app/desktop/src/features/chat/messageSelection.ts`
  - Pure helpers for selecting, deselecting, and toggling `MessageActionSource` entries in a conversation-scoped state.
- Create `app/desktop/tests/messageSelection.test.ts`
  - TDD coverage for helper behavior.
- Modify `app/desktop/src/kordi-app/components/transcript.tsx`
  - Add selection drag callbacks and pointer handlers on check controls.
- Modify `app/desktop/src/app/useKordiAppModel.ts`
  - Replace inline selection map updates with helper calls.
  - Add drag gesture ref and callbacks.
- Modify `app/desktop/src/app/kordiShellSlots.types.ts`, `app/desktop/src/app/mainContentShellBuilders.ts`, `app/desktop/src/app/useKordiShellArgs.ts`, and `app/desktop/src/pages/ChatsPage.tsx`
  - Thread new drag callbacks to `MessageBubble`.
- Modify `app/desktop/tests/transcriptDensity.test.tsx`
  - Add static markup regression for draggable selection controls.

---

### Task 1: Pure message selection helper

**Files:**
- Create: `app/desktop/src/features/chat/messageSelection.ts`
- Create: `app/desktop/tests/messageSelection.test.ts`

- [ ] **Step 1: Write failing tests**

Create `app/desktop/tests/messageSelection.test.ts` with:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { setMessageSelectionSource, toggleMessageSelectionSource, type MessageSelectionState } from '../src/features/chat/messageSelection';
import type { MessageActionSource } from '../src/features/chat/messageActionMetadata';

const source = (id: string): MessageActionSource => ({
  sourceSessionId: 'session:one',
  sourceMessageId: id,
  senderLabel: 'Alice',
  textPreview: id,
  attachmentCount: 0,
  createdAtMs: null,
  timeLabel: '10:42',
});

test('setMessageSelectionSource selects idempotently in the active conversation', () => {
  const first = source('msg:first');
  const selected = setMessageSelectionSource(null, 'conv:one', first, true);
  const selectedAgain = setMessageSelectionSource(selected, 'conv:one', first, true);

  assert.equal(selectedAgain?.conversationId, 'conv:one');
  assert.deepEqual([...selectedAgain!.sourcesByMessageId.keys()], ['msg:first']);
});

test('setMessageSelectionSource deselects and clears empty state', () => {
  const first = source('msg:first');
  const selected = setMessageSelectionSource(null, 'conv:one', first, true);
  const cleared = setMessageSelectionSource(selected, 'conv:one', first, false);

  assert.equal(cleared, null);
});

test('toggleMessageSelectionSource toggles without mutating previous state', () => {
  const first = source('msg:first');
  const previous = setMessageSelectionSource(null, 'conv:one', first, true) as MessageSelectionState;
  const toggled = toggleMessageSelectionSource(previous, 'conv:one', first);

  assert.equal(previous.sourcesByMessageId.has('msg:first'), true);
  assert.equal(toggled, null);
});
```

- [ ] **Step 2: Run failing tests**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/messageSelection.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement helper**

Create `app/desktop/src/features/chat/messageSelection.ts`:

```ts
import type { MessageActionSource } from './messageActionMetadata';

export type MessageSelectionState = {
  conversationId: string;
  sourcesByMessageId: Map<string, MessageActionSource>;
};

export function setMessageSelectionSource(
  current: MessageSelectionState | null,
  conversationId: string,
  source: MessageActionSource,
  selected: boolean,
): MessageSelectionState | null {
  const nextMap = current?.conversationId === conversationId
    ? new Map(current.sourcesByMessageId)
    : new Map<string, MessageActionSource>();

  if (selected) {
    nextMap.set(source.sourceMessageId, source);
  } else {
    nextMap.delete(source.sourceMessageId);
  }

  if (nextMap.size === 0) return null;
  return { conversationId, sourcesByMessageId: nextMap };
}

export function toggleMessageSelectionSource(
  current: MessageSelectionState | null,
  conversationId: string,
  source: MessageActionSource,
): MessageSelectionState | null {
  const currentlySelected = current?.conversationId === conversationId
    && current.sourcesByMessageId.has(source.sourceMessageId);
  return setMessageSelectionSource(current, conversationId, source, !currentlySelected);
}
```

- [ ] **Step 4: Run tests**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/messageSelection.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/desktop/src/features/chat/messageSelection.ts app/desktop/tests/messageSelection.test.ts
git commit -m "feat: add message selection state helpers"
```

---

### Task 2: Drag pointer callbacks in transcript

**Files:**
- Modify: `app/desktop/src/kordi-app/components/transcript.tsx`
- Modify: `app/desktop/tests/transcriptDensity.test.tsx`

- [ ] **Step 1: Write failing test**

Extend the existing selection control test to assert drag metadata:

```ts
assert.match(markup, /data-message-selection-draggable="true"/);
assert.match(markup, /data-message-selection-state="selected"/);
```

- [ ] **Step 2: Run failing test**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/transcriptDensity.test.tsx
```

Expected: FAIL because those attributes are not rendered.

- [ ] **Step 3: Implement pointer hooks**

Add callback props to `MessageSelectionProps`:

```ts
onSelectionDragStart?: (message: Message, shouldSelect: boolean) => void;
onSelectionDragEnter?: (message: Message) => void;
onSelectionDragEnd?: () => void;
```

On the selection control button:

- Add `data-message-selection-draggable="true"`.
- Add `data-message-selection-state={isSelectedForAction ? 'selected' : 'unselected'}`.
- On pointer down, prevent default, call drag start with `!isSelectedForAction`, attach a one-shot `window.pointerup` and `window.pointercancel` cleanup, and suppress the generated click.
- On pointer enter, call drag enter only when `event.buttons === 1`.
- Keep click behavior for keyboard/click toggles.

- [ ] **Step 4: Run tests**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/transcriptDensity.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/desktop/src/kordi-app/components/transcript.tsx app/desktop/tests/transcriptDensity.test.tsx
git commit -m "feat: add drag hooks to message selection controls"
```

---

### Task 3: App-model drag state wiring

**Files:**
- Modify: `app/desktop/src/app/useKordiAppModel.ts`
- Modify: `app/desktop/src/app/kordiShellSlots.types.ts`
- Modify: `app/desktop/src/app/mainContentShellBuilders.ts`
- Modify: `app/desktop/src/app/useKordiShellArgs.ts`
- Modify: `app/desktop/src/pages/ChatsPage.tsx`

- [ ] **Step 1: Implement with helper-backed selection**

In `useKordiAppModel.ts`:

- Import `setMessageSelectionSource`, `toggleMessageSelectionSource`, and `MessageSelectionState`.
- Type `messageSelection` as `MessageSelectionState | null`.
- Replace manual toggle map code with `toggleMessageSelectionSource`.
- Add `selectionDragRef = useRef<{ conversationId: string; shouldSelect: boolean } | null>(null)`.
- Implement:

```ts
const onSelectionDragStart = useCallback((message: Message, shouldSelect: boolean) => {
  const source = sourceForSelectableMessage(message);
  if (!source) return;
  selectionDragRef.current = { conversationId: activeConv.id, shouldSelect };
  setMessageSelection((current) => setMessageSelectionSource(current, activeConv.id, source, shouldSelect));
}, [activeConv.id, sourceForSelectableMessage]);

const onSelectionDragEnter = useCallback((message: Message) => {
  const drag = selectionDragRef.current;
  if (!drag || drag.conversationId !== activeConv.id) return;
  const source = sourceForSelectableMessage(message);
  if (!source) return;
  setMessageSelection((current) => setMessageSelectionSource(current, activeConv.id, source, drag.shouldSelect));
}, [activeConv.id, sourceForSelectableMessage]);

const onSelectionDragEnd = useCallback(() => {
  selectionDragRef.current = null;
}, []);
```

Thread callbacks through shell args to `ChatsPage`, then to `MessageBubble`.

- [ ] **Step 2: Run verification**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/messageSelection.test.ts tests/transcriptDensity.test.tsx tests/chatsPageQuotePreview.test.tsx tests/messageForwarding.test.tsx
pnpm --dir app/desktop typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add app/desktop/src/app/useKordiAppModel.ts app/desktop/src/app/kordiShellSlots.types.ts app/desktop/src/app/mainContentShellBuilders.ts app/desktop/src/app/useKordiShellArgs.ts app/desktop/src/pages/ChatsPage.tsx
git commit -m "feat: wire drag selection state"
```

---

### Task 4: Final verification and PR update

- [ ] **Step 1: Run full targeted verification**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/messageSelection.test.ts tests/messageForwarding.test.tsx tests/transcriptDensity.test.tsx tests/chatsPageQuotePreview.test.tsx tests/replyAttribution.test.tsx tests/cloudBridgeState.test.tsx tests/cloudDirectMessageEnvelope.test.ts tests/messageActionMetadata.test.ts tests/desktopTranscriptAdapter.test.tsx tests/bridgeAttachmentTransport.test.tsx tests/cloudSessionActions.test.ts
pnpm --dir app/desktop typecheck
git diff --check
```

Expected: all pass.

- [ ] **Step 2: Push and comment on PR**

```bash
git push
```

Add PR comment with summary and verification evidence.
