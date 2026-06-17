# Contact Session Density Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make human chat sessions show more messages per viewport using the approved **Balanced Compact** visual direction.

**Architecture:** Add explicit transcript density modes selected by `ChatsPage` from conversation context and passed down through `ChatSessionPane` into `MessageBubble`. Keep default transcript rendering unchanged for Agent sessions. In compact contact and compact group modes, human message bubbles hide inline sender names inside the message box. Both compact human modes use smaller avatar/spacer sizes, tighter vertical row spacing, and squarer/denser bubble padding while preserving message actions and status affordances.

**Tech Stack:** React, TypeScript, Tailwind utility classes, Node test runner with `tsx`, server-rendered markup tests in `app/desktop/tests/transcriptDensity.test.tsx`.

---

## Approved UI Direction

The user selected **Balanced Compact** from the browser mockup:

- Initially applied to contact/direct human sessions only; user later approved applying the same compact treatment to group human chats too.
- Hide sender labels in direct/contact chats because the session header/avatar already identifies the peer.
- In group chats, remove sender labels from inside message bubbles too, relying on avatars/header context instead of text inside the bubble.
- Make bubbles more compact and more square, not ultra-dense.
- Preserve Agent sessions unchanged.
- Preserve reply/forward/selection/context-menu/read-receipt/pin behavior.

## File Structure

- Modify: `app/desktop/src/kordi-app/components/transcript.tsx`
  - Add `TranscriptDensityMode` type.
  - Add optional `densityMode` prop to `MessageBubble`.
  - Apply compact direct/contact and group classes for human message rows and bubbles.
  - Include `densityMode` in `MessageBubble` memo comparison.
- Modify: `app/desktop/src/pages/ChatsPage.tsx`
  - Add helper to identify human sessions eligible for compact transcript density.
  - Add optional `densityMode` prop to `ChatSessionPane`.
  - Pass contact compact mode for main and side human direct/contact sessions, group compact mode for group chats, and default mode for Agent sessions.
- Modify: `app/desktop/tests/transcriptDensity.test.tsx`
  - Add/adjust tests proving compact contact bubbles hide names and use tighter/squarer classes.
  - Add group compact tests proving sender labels are removed from inside message bubbles.
  - Keep a default-mode test proving sender names still render where needed.

---

### Task 1: Add compact contact density to individual message bubbles

**Files:**
- Modify: `app/desktop/src/kordi-app/components/transcript.tsx`
- Test: `app/desktop/tests/transcriptDensity.test.tsx`

- [ ] **Step 1: Write the failing tests**

Add these tests near the existing peer human sender and grouped-message tests in `app/desktop/tests/transcriptDensity.test.tsx`:

```ts
test('compact contact density hides peer sender names and uses squarer tighter human bubbles', () => {
  const message: Message = {
    role: 'person',
    sender: 'xin hai Mouse',
    senderType: 'human',
    isOwnMessage: false,
    showSenderMeta: true,
    text: '我都不知道',
    time: '10:00',
    senderAvatarSeed: 'person:xinhai',
  };

  const markup = renderToStaticMarkup(createElement(MessageBubble, {
    msg: message,
    densityMode: 'contact-compact',
  }));

  assert.match(markup, /data-transcript-density="contact-compact"/);
  assert.match(markup, /app-message-row-contact-compact/);
  assert.match(markup, /app-message-bubble-contact-compact/);
  assert.match(markup, /px-3 py-1\.5/);
  assert.match(markup, /rounded-\[12px\]/);
  assert.match(markup, /h-5\.5 w-5\.5/);
  assert.doesNotMatch(markup, /app-message-inline-sender/);
  assert.doesNotMatch(markup, />xin hai Mouse<\/div>/);
});

test('default and group-style human bubbles still render inline sender names', () => {
  const message: Message = {
    role: 'person',
    sender: 'xin hai Mouse',
    senderType: 'human',
    isOwnMessage: false,
    showSenderMeta: true,
    text: 'Group context still needs a visible sender label.',
    time: '10:00',
    senderAvatarSeed: 'person:xinhai',
  };

  const markup = renderToStaticMarkup(createElement(MessageBubble, { msg: message }));

  assert.match(markup, /app-chat-bubble-peer[\s\S]*app-message-inline-sender/);
  assert.match(markup, />xin hai Mouse<\/div>/);
  assert.doesNotMatch(markup, /data-transcript-density="contact-compact"/);
});
```

- [ ] **Step 2: Run tests and verify they fail for missing compact mode**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/transcriptDensity.test.tsx
```

Expected: the new compact-density test fails because `densityMode` is not accepted/rendered yet.

- [ ] **Step 3: Add `densityMode` to `MessageBubble`**

In `app/desktop/src/kordi-app/components/transcript.tsx`, add a type near message bubble prop definitions:

```ts
export type TranscriptDensityMode = 'default' | 'contact-compact';
```

Add to `MessageBubbleView` props:

```ts
  densityMode?: TranscriptDensityMode;
```

Destructure with default:

```ts
  densityMode = 'default',
```

Add derived booleans after human/agent classification:

```ts
  const useContactCompactDensity = densityMode === 'contact-compact' && !isAgentMessage;
```

Change inline sender logic from:

```ts
  const showInlineHumanSender = Boolean(!isAgentMessage && msg.showSenderMeta && msg.sender && !isGroupedWithPrevious);
```

to:

```ts
  const showInlineHumanSender = Boolean(!useContactCompactDensity && !isAgentMessage && msg.showSenderMeta && msg.sender && !isGroupedWithPrevious);
```

Update the row classes inside `MessageContextMenuHost`:

```ts
      className={cn(
        'flex w-full flex-col gap-1',
        useContactCompactDensity ? (isGroupedWithPrevious ? 'pt-0.5' : 'pt-0.5') : (isGroupedWithPrevious ? 'pt-0.5' : 'pt-1'),
        useContactCompactDensity ? (isGroupedWithNext ? 'pb-0' : 'pb-0.5') : (isGroupedWithNext ? 'pb-0' : 'pb-1'),
        useContactCompactDensity ? 'app-message-row-contact-compact' : '',
        align,
        isAgentMessage ? 'w-full max-w-[min(100%,42rem)]' : '',
        showContactRequestAction ? 'w-full' : '',
        isSelectedForAction ? 'app-message-selection-selected' : '',
      )}
      data-transcript-density={useContactCompactDensity ? 'contact-compact' : undefined}
```

Update avatar/spacer classes:

```tsx
            className={cn(
              'mb-0.5 border border-white/10',
              useContactCompactDensity ? 'h-5.5 w-5.5' : 'h-7 w-7',
            )}
```

and:

```tsx
          <span className={cn('app-message-avatar-spacer shrink-0', useContactCompactDensity ? 'h-5.5 w-5.5' : 'h-7 w-7')} aria-hidden="true" />
```

Update the flex gap wrapper:

```tsx
      <div className={cn(
        'flex items-end',
        showAvatarSlot || selectionControl ? (useContactCompactDensity ? 'gap-1.5' : 'gap-2') : 'gap-0',
        isOwnHumanMessage ? 'flex-row-reverse' : 'flex-row',
        isAgentMessage ? 'w-full' : '',
      )}>
```

Update human bubble classes by replacing the human bubble branches with compact-aware classes:

```ts
          isOwnHumanMessage
            ? hasOnlyImageAttachments
              ? 'w-fit max-w-[31rem] p-0'
              : useContactCompactDensity
                ? cn('app-message-bubble-contact-compact w-fit min-w-[5.5rem] max-w-[36rem] rounded-[8px] px-3 py-1.5', humanMessageBubbleShapeClass('own'))
                : cn('w-fit min-w-[6.75rem] max-w-[34rem] px-4 py-2.5', humanMessageBubbleShapeClass('own'))
            : isPeerHumanMessage
              ? hasOnlyImageAttachments
                ? 'w-fit max-w-[31rem] p-0'
                : useContactCompactDensity
                  ? cn('app-message-bubble-contact-compact w-fit min-w-[5.5rem] max-w-[36rem] rounded-[8px] px-3 py-1.5', humanMessageBubbleShapeClass('peer'))
                  : cn('w-fit min-w-[6.75rem] max-w-[34rem] px-4 py-2.5', humanMessageBubbleShapeClass('peer'))
              : 'w-fit max-w-full rounded-[20px] px-3.5 py-2.5',
```

Add `densityMode` to `messageSnapshotKey` or the memo comparator. Prefer comparator:

```ts
    && previous.densityMode === next.densityMode
```

- [ ] **Step 4: Run tests and verify Task 1 passes**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/transcriptDensity.test.tsx
```

Expected: all transcript density tests pass.

- [ ] **Step 5: Commit Task 1**

```bash
git add app/desktop/src/kordi-app/components/transcript.tsx app/desktop/tests/transcriptDensity.test.tsx
git commit -m "feat: add compact contact message density"
```

---

### Task 2: Apply compact density to human sessions while preserving Agent defaults

**Files:**
- Modify: `app/desktop/src/pages/ChatsPage.tsx`
- Test: `app/desktop/tests/chatHeaderBadge.test.tsx` or `app/desktop/tests/panelAgentSessionParity.test.ts`

- [ ] **Step 1: Write failing source-level tests for mode plumbing**

Add a test to `app/desktop/tests/chatHeaderBadge.test.tsx` near other chat companion/header source tests:

```ts
test('compact transcript density applies to human chats but not agent sessions', () => {
  const source = readFileSync(new URL('../src/pages/ChatsPage.tsx', import.meta.url), 'utf8');

  assert.match(source, /function chatTranscriptDensityMode\(conversation: Conversation\)/);
  assert.match(source, /conversationUsesCompactHumanTranscriptDensity\(conversation\)/);
  assert.match(source, /densityMode=\{chatTranscriptDensityMode\(activeConv\)\}/);
  assert.match(source, /densityMode=\{chatTranscriptDensityMode\(companionConversation\)\}/);
  assert.match(source, /if \(conversationIsAgentChat\(conversation\)\) return 'default';/);
  assert.match(source, /if \(conversationIsGroupChat\(conversation\)\) return 'group-compact';/);
  assert.match(source, /return 'contact-compact'/);
  assert.match(source, /return 'default'/);
});
```

- [ ] **Step 2: Run test and verify it fails**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/chatHeaderBadge.test.tsx
```

Expected: FAIL because `chatTranscriptDensityMode` is not implemented/passed yet.

- [ ] **Step 3: Add `densityMode` prop to `ChatSessionPane`**

In `app/desktop/src/pages/ChatsPage.tsx`, import the type if needed:

```ts
import type { TranscriptDensityMode } from '@/kordi-app/components';
```

If the type cannot be re-exported from the barrel, import from transcript directly:

```ts
import type { TranscriptDensityMode } from '@/kordi-app/components/transcript';
```

Add to `ChatSessionPaneProps`:

```ts
  densityMode?: TranscriptDensityMode;
```

Destructure with default:

```ts
  densityMode = 'default',
```

Pass into both real and queued message bubbles:

```tsx
                densityMode={densityMode}
```

- [ ] **Step 4: Add human session density detection**

In `app/desktop/src/pages/ChatsPage.tsx`, near `conversationIsGroupChat` / `conversationIsHumanChat`, add:

```ts
function conversationUsesCompactHumanTranscriptDensity(conversation: Conversation) {
  if (conversationIsAgentChat(conversation)) return false;
  if (conversationIsGroupChat(conversation)) return true;
  if (conversation.type === 'person') return true;
  const directness = conversation.directness?.trim().toLowerCase() ?? '';
  if (/\b(?:direct|person|contact)\b/.test(directness)) return true;
  const nonSelfHumanCount = (conversation.canonicalParticipants ?? [])
    .filter((participant) => !participantIsSelf(participant) && participant.kind === 'human')
    .length;
  return nonSelfHumanCount === 1;
}

function chatTranscriptDensityMode(conversation: Conversation): TranscriptDensityMode {
  if (conversationIsAgentChat(conversation)) return 'default';
  if (conversationIsGroupChat(conversation)) return 'group-compact';
  if (conversationUsesCompactHumanTranscriptDensity(conversation)) return 'contact-compact';
  return 'default';
}
```

- [ ] **Step 5: Pass density mode to main and side panes**

In the side `ChatSessionPane` call, add:

```tsx
        densityMode={chatTranscriptDensityMode(companionConversation)}
```

In the main `ChatSessionPane` call, add:

```tsx
        densityMode={chatTranscriptDensityMode(activeConv)}
```

- [ ] **Step 6: Run tests and verify Task 2 passes**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/chatHeaderBadge.test.tsx tests/panelAgentSessionParity.test.ts tests/transcriptDensity.test.tsx
```

Expected: all listed tests pass.

- [ ] **Step 7: Commit Task 2**

```bash
git add app/desktop/src/pages/ChatsPage.tsx app/desktop/tests/chatHeaderBadge.test.tsx
git commit -m "feat: scope compact density to contact chats"
```

---

### Task 3: Final verification and PR readiness

**Files:**
- No production files expected.

- [ ] **Step 1: Run focused/adjacent tests**

```bash
pnpm --dir app/desktop exec tsx --test tests/transcriptDensity.test.tsx tests/chatHeaderBadge.test.tsx tests/panelAgentSessionParity.test.ts tests/chatsPageQuotePreview.test.tsx
```

Expected: all tests pass.

- [ ] **Step 2: Run TypeScript**

```bash
pnpm --dir app/desktop exec tsc --noEmit --pretty false
```

Expected: exit 0.

- [ ] **Step 3: Run whitespace check**

```bash
git diff --check
```

Expected: no output and exit 0.

- [ ] **Step 4: Manual preview checklist**

Run or reuse local desktop preview and verify:

- Direct/contact chat shows more messages in the same viewport.
- Direct/contact peer bubbles do not repeat the peer name above/inside every bubble.
- Direct/contact bubbles are squarer and less padded, but still readable.
- Group chat still shows sender names.
- Agent chat is not compacted by this change.
- Reply quotes, forwarded headers, attachments, context menu, selection, read receipts, and pin/unpin still work.

- [ ] **Step 5: Open PR**

```bash
git status --short
git push -u origin fix/issue-581-contact-session-density
gh pr create --base main --head fix/issue-581-contact-session-density --title "feat: compact contact chat transcript density" --body-file /tmp/kordi-pr-581-body.md
```

Use this PR body:

```md
## Summary
- Adds compact transcript density modes for direct/contact and group human chat sessions.
- Hides sender names inside direct/contact and group message bubbles, and tightens avatar, row, and bubble spacing.
- Keeps Agent sessions on the default transcript density.

Closes #581.

## Test Plan
- [ ] `pnpm --dir app/desktop exec tsx --test tests/transcriptDensity.test.tsx tests/chatHeaderBadge.test.tsx tests/panelAgentSessionParity.test.ts tests/chatsPageQuotePreview.test.tsx`
- [ ] `pnpm --dir app/desktop exec tsc --noEmit --pretty false`
- [ ] `git diff --check`
- [ ] Manual preview: contact/direct and group chats are denser with no sender names inside message bubbles; Agent sessions unchanged.
```

---

## Self-Review

- Spec coverage: The plan implements Balanced Compact for direct/contact and group human sessions, hides sender names inside compact human message bubbles, uses tighter/squarer bubbles, and preserves Agent defaults.
- Placeholder scan: No placeholders, TODOs, or undefined implementation steps remain.
- Type consistency: `TranscriptDensityMode`, `densityMode`, `conversationUsesCompactHumanTranscriptDensity`, and `chatTranscriptDensityMode` names are consistent across tasks.
