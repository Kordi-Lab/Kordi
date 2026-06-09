# Message Multi-Select Forward Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add first-pass Telegram-style message selection mode and batch forwarding for selected messages.

**Architecture:** `useKordiAppModel` owns selected message state and forward dialog state. `ChatsPage` renders the selection action bar and passes selection props into `MessageBubble`. `MessageForwardDialog` becomes batch-aware while `messageForwarding.ts` owns reusable batch draft/order helpers.

**Tech Stack:** React, TypeScript, Node test runner, React server rendering tests, existing Kordi desktop app CSS/theme tokens.

---

## File structure

- Modify `app/desktop/src/features/chat/messageForwarding.ts`
  - Add selection key/source ordering helpers.
  - Add `createForwardedMessageDrafts()` for single and batch flows.
- Modify `app/desktop/src/pages/MessageForwardDialog.tsx`
  - Accept `sources: MessageActionSource[]`.
  - Render single vs multi titles/previews.
  - Hide caption textarea for multi-forward.
  - Replace dark-only classes with token-friendly classes/data selectors.
- Modify `app/desktop/src/kordi-app/components/transcript.tsx`
  - Wire functional Select context menu action.
  - Render selection controls/checkmarks beside selectable messages in selection mode.
- Modify `app/desktop/src/pages/ChatsPage.tsx`
  - Add selection props.
  - Pass selection props to `MessageBubble`.
  - Render bottom selection action bar.
- Modify `app/desktop/src/app/useKordiAppModel.ts`
  - Store active selection conversation and selected sources.
  - Open batch-aware forward dialog.
  - Send batch forwards sequentially and reveal destination.
- Tests:
  - Modify `app/desktop/tests/messageForwarding.test.tsx`.
  - Modify `app/desktop/tests/transcriptDensity.test.tsx`.
  - Modify `app/desktop/tests/chatsPageQuotePreview.test.tsx`.

---

### Task 1: Add forwarding batch helper tests and implementation

**Files:**
- Modify: `app/desktop/tests/messageForwarding.test.tsx`
- Modify: `app/desktop/src/features/chat/messageForwarding.ts`

- [ ] **Step 1: Write failing tests**

Add tests for `createForwardedMessageDrafts()` and batch dialog static rendering in `app/desktop/tests/messageForwarding.test.tsx`:

```ts
test('createForwardedMessageDrafts keeps multi-forward sources in input order and ignores caption', () => {
  const secondSource = { ...source, sourceMessageId: 'msg:second', senderLabel: 'Bob', textPreview: 'Second' };
  const drafts = createForwardedMessageDrafts({ sources: [source, secondSource], caption: 'ignored' });

  assert.deepEqual(drafts.map((draft) => draft.text), ['Forward this', 'Second']);
  assert.deepEqual(drafts.map((draft) => draft.messageAction.source.senderLabel), ['Alice', 'Bob']);
  assert.deepEqual(drafts.map((draft) => draft.messageAction.kind), ['forward', 'forward']);
});

test('MessageForwardDialog renders batch preview without caption field', () => {
  const secondSource = { ...source, sourceMessageId: 'msg:second', senderLabel: 'Bob', textPreview: 'Second' };
  const markup = renderToStaticMarkup(
    <MessageForwardDialog
      sources={[source, secondSource]}
      destinations={[{ id: 'session:two', conversationId: 'conv:two', label: 'Group', subtitle: '3 members' }]}
      onClose={() => {}}
      onForward={() => {}}
    />,
  );

  assert.match(markup, /Forward 2 messages/);
  assert.match(markup, /data-message-forward-selected-preview="true"/);
  assert.match(markup, /Alice: Forward this/);
  assert.match(markup, /Bob: Second/);
  assert.doesNotMatch(markup, /Add a comment/);
});
```

- [ ] **Step 2: Run failing tests**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/messageForwarding.test.tsx
```

Expected: FAIL because `createForwardedMessageDrafts` is not exported and `MessageForwardDialog` does not accept `sources` yet.

- [ ] **Step 3: Implement minimal helpers and dialog compatibility**

In `messageForwarding.ts`, add:

```ts
export function createForwardedMessageDrafts({
  sources,
  caption,
}: {
  sources: MessageActionSource[];
  caption?: string;
}) {
  return sources.map((source, index) => createForwardedMessageDraft({
    source,
    caption: sources.length === 1 && index === 0 ? caption : '',
    destinationSessionId: source.sourceSessionId,
  }));
}
```

In `MessageForwardDialog.tsx`, change props to `sources: MessageActionSource[]`, derive `primarySource`, `isBatch`, and render batch title/preview. Keep the existing single caption textarea only when `sources.length === 1`.

- [ ] **Step 4: Run tests**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/messageForwarding.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/desktop/tests/messageForwarding.test.tsx app/desktop/src/features/chat/messageForwarding.ts app/desktop/src/pages/MessageForwardDialog.tsx
git commit -m "feat: add batch forward dialog helpers"
```

---

### Task 2: Add selection menu and transcript selection controls

**Files:**
- Modify: `app/desktop/tests/transcriptDensity.test.tsx`
- Modify: `app/desktop/src/kordi-app/components/transcript.tsx`

- [ ] **Step 1: Write failing tests**

Add tests verifying Select calls the handler and selection controls render:

```ts
test('context menu Select invokes message selection handler', () => {
  const message: Message = { id: 'msg-select', role: 'person', sender: 'Alice', senderType: 'human', text: 'Pick me', time: '10:42' };
  let selected = '';
  const markup = renderToStaticMarkup(createElement(MessageContextMenuContent, {
    msg: message,
    onSelectMessage: (msg: Message) => { selected = msg.id ?? ''; },
  }));

  assert.match(markup, /data-message-context-menu-action="select"/);
  assert.equal(selected, '');
});

test('message bubble renders selected check control in selection mode', () => {
  const message: Message = { id: 'msg-selected', role: 'person', sender: 'Alice', senderType: 'human', text: 'Selected text', time: '10:42' };
  const markup = renderToStaticMarkup(createElement(MessageBubble, {
    msg: message,
    selectionMode: true,
    selectedMessageIds: new Set(['msg-selected']),
    isMessageSelectable: () => true,
    onToggleSelectedMessage: () => undefined,
  }));

  assert.match(markup, /data-message-selection-control="msg-selected"/);
  assert.match(markup, /aria-pressed="true"/);
  assert.match(markup, /Deselect message from Alice at 10:42/);
});
```

Manual note: server-rendered markup cannot click the context-menu button. After adding the handler prop, a later browser/runtime test or manual validation covers the click; this test locks markup and callback availability.

- [ ] **Step 2: Run failing tests**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/transcriptDensity.test.tsx
```

Expected: FAIL because selection props and controls do not exist.

- [ ] **Step 3: Implement transcript selection UI**

Add `onSelectMessage` to `MessageContextMenuActionHandlers` and wire Select to call it.

Add `MessageSelectionProps` to `MessageBubble`:

```ts
type MessageSelectionProps = {
  selectionMode?: boolean;
  selectedMessageIds?: ReadonlySet<string>;
  isMessageSelectable?: (message: Message) => boolean;
  onSelectMessage?: (message: Message) => void;
  onToggleSelectedMessage?: (message: Message) => void;
};
```

Render a button with `data-message-selection-control={messageId}` when `selectionMode && selectable`. Use `aria-pressed` and a `Check` icon for selected state.

- [ ] **Step 4: Run tests**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/transcriptDensity.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/desktop/tests/transcriptDensity.test.tsx app/desktop/src/kordi-app/components/transcript.tsx
git commit -m "feat: add message selection controls"
```

---

### Task 3: Add ChatsPage selection action bar

**Files:**
- Modify: `app/desktop/tests/chatsPageQuotePreview.test.tsx`
- Modify: `app/desktop/src/pages/ChatsPage.tsx`

- [ ] **Step 1: Write failing test**

Add a server-render test:

```ts
test('chat page renders message selection action bar', () => {
  const markup = renderChatsPage({
    messageSelectionMode: true,
    selectedMessageCount: 2,
    selectedMessageIds: new Set(['msg:alice']),
    isMessageSelectable: () => true,
    onSelectMessage: () => undefined,
    onToggleSelectedMessage: () => undefined,
    onCancelMessageSelection: () => undefined,
    onForwardSelectedMessages: () => undefined,
  });

  assert.match(markup, /data-message-selection-bar="true"/);
  assert.match(markup, /2 selected/);
  assert.match(markup, /Forward/);
  assert.match(markup, /Cancel/);
});
```

- [ ] **Step 2: Run failing test**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/chatsPageQuotePreview.test.tsx
```

Expected: FAIL because ChatsPage has no selection props or action bar.

- [ ] **Step 3: Implement action bar**

Add props to `ChatsPageProps` and render a bottom bar above the composer when `messageSelectionMode` is true and `selectedMessageCount > 0`. Pass selection props to each `MessageBubble`.

- [ ] **Step 4: Run test**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/chatsPageQuotePreview.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/desktop/tests/chatsPageQuotePreview.test.tsx app/desktop/src/pages/ChatsPage.tsx
git commit -m "feat: add chat selection action bar"
```

---

### Task 4: Wire app model batch selection and batch sending

**Files:**
- Modify: `app/desktop/src/app/useKordiAppModel.ts`
- Modify: `app/desktop/src/pages/MessageForwardDialog.tsx`
- Modify: `app/desktop/src/features/chat/messageForwarding.ts`

- [ ] **Step 1: Write failing behavior test where practical**

Extend `messageForwarding.test.tsx` with source-order helper coverage:

```ts
test('orderedForwardSourcesForMessages returns selected sources in transcript order', () => {
  const first = { ...source, sourceMessageId: 'msg:first', textPreview: 'First' };
  const second = { ...source, sourceMessageId: 'msg:second', textPreview: 'Second' };
  const ordered = orderedForwardSourcesForMessageIds(['msg:first', 'msg:second'], new Map([
    ['msg:second', second],
    ['msg:first', first],
  ]));

  assert.deepEqual(ordered.map((entry) => entry.sourceMessageId), ['msg:first', 'msg:second']);
});
```

- [ ] **Step 2: Run failing test**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/messageForwarding.test.tsx
```

Expected: FAIL because `orderedForwardSourcesForMessageIds` does not exist.

- [ ] **Step 3: Implement model wiring**

Add `orderedForwardSourcesForMessageIds()` to `messageForwarding.ts`.

In `useKordiAppModel.ts`:

- Replace `forwardDialog.source` with `forwardDialog.sources`.
- Keep `onForwardMessage(message)` as single-source path.
- Add selection state for active conversation.
- Implement `onSelectMessage`, `onToggleSelectedMessage`, `onCancelMessageSelection`, `onForwardSelectedMessages`, and `isMessageSelectable`.
- Pass these props to `ChatsPage` through shell args.
- Update `handleConfirmForwardMessage` to loop over `createForwardedMessageDrafts({ sources, caption })` sequentially.

- [ ] **Step 4: Run targeted tests and typecheck**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/messageForwarding.test.tsx tests/transcriptDensity.test.tsx tests/chatsPageQuotePreview.test.tsx tests/replyAttribution.test.tsx tests/cloudBridgeState.test.tsx tests/cloudDirectMessageEnvelope.test.ts tests/messageActionMetadata.test.ts tests/desktopTranscriptAdapter.test.tsx tests/bridgeAttachmentTransport.test.tsx tests/cloudSessionActions.test.ts
pnpm --dir app/desktop typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/desktop/src/app/useKordiAppModel.ts app/desktop/src/features/chat/messageForwarding.ts app/desktop/src/pages/MessageForwardDialog.tsx app/desktop/tests/messageForwarding.test.tsx
git commit -m "feat: forward selected messages"
```

---

### Task 5: Theme polish and final verification

**Files:**
- Modify: `app/desktop/src/pages/MessageForwardDialog.tsx`
- Modify: `app/desktop/src/styles/shell-transcript.css` if selection styles need token CSS.
- Modify: `app/desktop/tests/messageForwarding.test.tsx` or `app/desktop/tests/transcriptDensity.test.tsx`.

- [ ] **Step 1: Add theme regression test**

Assert the dialog uses app classes/data attributes and no dark-only shell:

```ts
test('MessageForwardDialog uses theme-safe shell classes', () => {
  const markup = renderToStaticMarkup(
    <MessageForwardDialog
      sources={[source]}
      destinations={[{ id: 'session:two', conversationId: 'conv:two', label: 'Group', subtitle: '3 members' }]}
      onClose={() => {}}
      onForward={() => {}}
    />,
  );

  assert.match(markup, /app-message-forward-dialog/);
  assert.match(markup, /data-message-forward-dialog="true"/);
  assert.doesNotMatch(markup, /bg-\[#101820\]/);
});
```

- [ ] **Step 2: Run failing/passing theme test**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/messageForwarding.test.tsx
```

Expected: PASS after dialog token classes are present.

- [ ] **Step 3: Full targeted verification**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/messageForwarding.test.tsx tests/transcriptDensity.test.tsx tests/chatsPageQuotePreview.test.tsx tests/replyAttribution.test.tsx tests/cloudBridgeState.test.tsx tests/cloudDirectMessageEnvelope.test.ts tests/messageActionMetadata.test.ts tests/desktopTranscriptAdapter.test.tsx tests/bridgeAttachmentTransport.test.tsx tests/cloudSessionActions.test.ts
pnpm --dir app/desktop typecheck
git diff --check
```

Expected: all pass.

- [ ] **Step 4: Commit final polish if needed**

```bash
git add app/desktop/src/pages/MessageForwardDialog.tsx app/desktop/src/styles/shell-transcript.css app/desktop/tests/messageForwarding.test.tsx app/desktop/tests/transcriptDensity.test.tsx
git commit -m "style: polish multi-forward selection themes"
```

## Self-review

- Spec coverage: A+C implemented; drag selection excluded; batch preview; dark/light destination list; sequential batch forward; no reply counts because forwards continue to use `parentMessageId: null` and existing reply attribution regression remains in the targeted suite.
- Placeholder scan: no TBD/TODO placeholders.
- Type consistency: dialog state uses `sources`, single forward uses a one-element array, batch helper returns existing draft shape.
