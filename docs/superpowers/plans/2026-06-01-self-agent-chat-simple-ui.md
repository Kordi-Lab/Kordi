# Self-Agent Chat Simple UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Simplify only user-vs-own-agent Agent chat sessions by suppressing reply quote cards and reply reply-line chrome for agent replies while preserving attribution in every other session type.

**Architecture:** Keep attribution computation centralized in `features/chat/replyAttribution.ts`, but add an opt-in suppression mode used only by `ChatsPage` when `activeConv.type === 'owned-agent'`. Suppression should strip UI-facing `sourceMessage` and `replySummary` from the attributed transcript while still using the resolved source internally for no-provider duplicate removal.

**Tech Stack:** React 19, TypeScript, Tauri desktop app, Node `tsx --test`, server-rendered React markup assertions.

---

## Code review findings

- `app/desktop/src/pages/ChatsPage.tsx` builds all rendered transcript messages through `buildReplyAttribution(...)` before passing them to `MessageBubble` and `LiveChatTurnMessage`.
- `buildReplyAttribution(...)` currently links owned-agent replies to the latest plain user request even when `inferLatestHumanRequest` is false, through `isLocalAgentResponseMessage(...)` in `inferredReplyTargetForAgentMessage(...)`.
- Historical owned-agent replies render through `MessageBubble` as `msg.turn`, which then renders `LiveChatTurnCard`.
- `LiveChatTurnCard` renders the visible quote card when `turn.sourceMessage` exists via `<SourceMessageQuote />`.
- User request reply-line chrome renders from `msg.replySummary` through `<RequestReplyLine />` in `MessageBubble`.
- Therefore the minimal safe fix is not a CSS hide and not a global `MessageBubble` change. It should be a context-aware attribution option passed only for owned-agent Agent chat sessions.
- Do not remove attribution globally. Direct person chats, groups, group agent mentions, cross-user agent chats, and project sessions still need reply context.

## File structure

- Modify: `app/desktop/src/features/chat/replyAttribution.ts`
  - Add `suppressAgentReplyAttribution?: boolean` option.
  - Strip source/summary fields from output when suppression is enabled.
  - Keep no-provider dedupe behavior by resolving the source internally before stripping UI attribution.
- Modify: `app/desktop/src/pages/ChatsPage.tsx`
  - Pass `suppressAgentReplyAttribution: activeConv.type === 'owned-agent'` into `buildReplyAttribution`.
- Modify: `app/desktop/tests/replyAttribution.test.tsx`
  - Unit test suppression for historical agent replies and live turns.
  - Unit test default attribution remains intact for other contexts.
- Modify: `app/desktop/tests/desktopTranscriptAdapter.test.tsx`
  - Markup test that the self-agent path renders no source quote and no request reply line.

---

### Task 1: Add failing unit tests for suppression in `buildReplyAttribution`

**Files:**
- Modify: `app/desktop/tests/replyAttribution.test.tsx`

- [ ] **Step 1: Add the failing historical reply suppression test**

Append this test near the other `buildReplyAttribution` tests:

```ts
test('buildReplyAttribution suppresses reply chrome for self-agent chat replies when requested', () => {
  const source = {
    messageId: 'msg:self-request',
    senderLabel: 'Me',
    text: 'check again',
    attachmentCount: 0,
    time: '10:00',
  };
  const messages: Message[] = [
    humanRequest({
      id: 'msg:self-request',
      text: 'check again',
    }),
    {
      id: 'msg:self-agent-answer',
      role: 'owned-agent',
      sender: 'My Kordi',
      senderType: 'agent',
      text: '',
      time: '10:01',
      replyToMessageId: 'msg:self-request',
      sourceMessage: source,
      turn: turn({
        id: 'turn-self-agent-answer',
        assistantText: 'Still no reply yet.',
        replyToMessageId: 'msg:self-request',
        sourceMessage: source,
      }),
    },
  ];

  const result = buildReplyAttribution(messages, null, {
    inferLatestHumanRequest: false,
    suppressAgentReplyAttribution: true,
  });

  assert.equal(result.messages[0]?.replySummary, undefined);
  assert.equal(result.messages[1]?.replySummary, undefined);
  assert.equal(result.messages[1]?.sourceMessage, undefined);
  assert.equal(result.messages[1]?.turn?.sourceMessage, undefined);
  assert.equal(result.messages[1]?.turn?.replyToMessageId, undefined);
});
```

- [ ] **Step 2: Add the failing live turn suppression test**

Append this test near the live turn attribution tests:

```ts
test('buildReplyAttribution suppresses live turn reply chrome for self-agent chat when requested', () => {
  const request = humanRequest({
    id: 'msg:live-self-request',
    text: 'check again',
  });
  const liveTurn = turn({
    id: 'live-turn-self-agent',
    sessionId: 'session:self-agent',
    prompt: 'check again',
    status: 'thinking',
    message: 'Thinking…',
    assistantText: '',
    completed: false,
    succeeded: false,
  });

  const result = buildReplyAttribution([request], liveTurn, {
    inferLatestHumanRequest: false,
    suppressAgentReplyAttribution: true,
  });

  assert.equal(result.messages[0]?.replySummary, undefined);
  assert.equal(result.liveTurn?.sourceMessage, undefined);
  assert.equal(result.liveTurn?.replyToMessageId, undefined);
});
```

- [ ] **Step 3: Add the no-provider dedupe preservation test**

Append this test after the existing no-provider dedupe test:

```ts
test('buildReplyAttribution still deduplicates no-provider replies when self-agent reply chrome is suppressed', () => {
  const messages: Message[] = [
    humanRequest({
      id: 'msg:no-provider-request',
      text: '@MyKordi hello',
    }),
    {
      id: 'msg:no-provider-a',
      role: 'owned-agent',
      sender: 'My Kordi',
      senderType: 'agent',
      text: 'No provider configured yet.',
      time: '10:01',
      replyToMessageId: 'msg:no-provider-request',
      turn: turn({
        id: 'turn-no-provider-a',
        status: 'failed',
        assistantText: '',
        completed: true,
        succeeded: false,
        error: 'No provider configured yet.',
      }),
    },
    {
      id: 'msg:no-provider-b',
      role: 'owned-agent',
      sender: 'My Kordi',
      senderType: 'agent',
      text: 'No provider configured yet.',
      time: '10:01',
      replyToMessageId: 'msg:no-provider-request',
      turn: turn({
        id: 'turn-no-provider-b',
        status: 'failed',
        assistantText: '',
        completed: true,
        succeeded: false,
        error: 'No provider configured yet.',
      }),
    },
  ];

  const result = buildReplyAttribution(messages, null, {
    suppressAgentReplyAttribution: true,
  });

  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[0]?.replySummary, undefined);
  assert.equal(result.messages[1]?.turn?.sourceMessage, undefined);
});
```

- [ ] **Step 4: Run tests and verify they fail for the expected reason**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/replyAttribution.test.tsx
```

Expected: TypeScript/test failures because `suppressAgentReplyAttribution` does not exist yet, or assertion failures because source attribution is still present.

---

### Task 2: Implement suppression in `replyAttribution.ts`

**Files:**
- Modify: `app/desktop/src/features/chat/replyAttribution.ts`

- [ ] **Step 1: Extend the options type**

Replace the inline options type in `buildReplyAttribution`:

```ts
options: { inferLatestHumanRequest?: boolean } = {},
```

with:

```ts
options: { inferLatestHumanRequest?: boolean; suppressAgentReplyAttribution?: boolean } = {},
```

- [ ] **Step 2: Add strip helpers after `withSourceMessage(...)`**

Add:

```ts
function withoutAgentReplyAttribution(message: Message): Message {
  if (!isAgentResponse(message)) return { ...message, replySummary: undefined };
  return {
    ...message,
    replyToMessageId: undefined,
    replySummary: undefined,
    sourceMessage: undefined,
    turn: message.turn
      ? {
          ...message.turn,
          replyToMessageId: undefined,
          sourceMessage: undefined,
        }
      : message.turn,
  };
}

function withoutLiveTurnReplyAttribution(turn: DesktopChatTurnSnapshot): DesktopChatTurnSnapshot {
  return {
    ...turn,
    replyToMessageId: undefined,
    sourceMessage: undefined,
  };
}
```

- [ ] **Step 3: Read the suppression flag inside `buildReplyAttribution`**

After:

```ts
const inferLatestHumanRequest = Boolean(options.inferLatestHumanRequest);
```

add:

```ts
const suppressAgentReplyAttribution = Boolean(options.suppressAgentReplyAttribution);
```

- [ ] **Step 4: Suppress linked message output while preserving no-provider dedupe**

In the `linkedMessages` map, replace:

```ts
addReplySummary(summariesByRequestId, sourceMessage.messageId, messageId, completedReplyCountable(message));
return withSourceMessage({ ...message, replyToMessageId: sourceMessage.messageId }, sourceMessage);
```

with:

```ts
if (suppressAgentReplyAttribution) {
  return withoutAgentReplyAttribution(message);
}

addReplySummary(summariesByRequestId, sourceMessage.messageId, messageId, completedReplyCountable(message));
return withSourceMessage({ ...message, replyToMessageId: sourceMessage.messageId }, sourceMessage);
```

Also update the early no-reply-target paths so existing source fields are stripped in suppression mode:

```ts
if (!replyTargetId) return suppressAgentReplyAttribution ? withoutAgentReplyAttribution(message) : message;
const sourceMessage = sourceByMessageId.get(replyTargetId);
if (!sourceMessage) return suppressAgentReplyAttribution ? withoutAgentReplyAttribution(message) : message;
```

- [ ] **Step 5: Suppress live turn output**

In `linkedLiveTurn`, replace:

```ts
if (!replyTargetId) return liveTurn;
const sourceMessage = sourceByMessageId.get(replyTargetId);
if (!sourceMessage) return liveTurn;
addReplySummary(summariesByRequestId, sourceMessage.messageId, liveTurn.id, liveTurn.completed);
return {
  ...liveTurn,
  replyToMessageId: sourceMessage.messageId,
  sourceMessage: liveTurn.sourceMessage ?? sourceMessage,
};
```

with:

```ts
if (!replyTargetId) return suppressAgentReplyAttribution ? withoutLiveTurnReplyAttribution(liveTurn) : liveTurn;
const sourceMessage = sourceByMessageId.get(replyTargetId);
if (!sourceMessage) return suppressAgentReplyAttribution ? withoutLiveTurnReplyAttribution(liveTurn) : liveTurn;
if (suppressAgentReplyAttribution) return withoutLiveTurnReplyAttribution(liveTurn);
addReplySummary(summariesByRequestId, sourceMessage.messageId, liveTurn.id, liveTurn.completed);
return {
  ...liveTurn,
  replyToMessageId: sourceMessage.messageId,
  sourceMessage: liveTurn.sourceMessage ?? sourceMessage,
};
```

- [ ] **Step 6: Suppress final reply summaries**

Replace the final `messages` mapping:

```ts
const messages = linkedMessages.map((message) => {
  const messageId = cleanText(message.id);
  const summary = messageId ? summariesByRequestId.get(messageId) : undefined;
  return summary ? { ...message, replySummary: summary } : message;
});
```

with:

```ts
const messages = suppressAgentReplyAttribution
  ? linkedMessages.map(withoutAgentReplyAttribution)
  : linkedMessages.map((message) => {
      const messageId = cleanText(message.id);
      const summary = messageId ? summariesByRequestId.get(messageId) : undefined;
      return summary ? { ...message, replySummary: summary } : message;
    });
```

- [ ] **Step 7: Run tests and verify Task 1 is green**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/replyAttribution.test.tsx
```

Expected: all tests in `replyAttribution.test.tsx` pass.

---

### Task 3: Wire suppression only for user-vs-own-agent Agent chat sessions

**Files:**
- Modify: `app/desktop/src/pages/ChatsPage.tsx`

- [ ] **Step 1: Add the scoped boolean**

Near:

```ts
const inferLatestHumanReplyTarget = shouldInferLatestHumanReplyTarget(activeConv);
```

add:

```ts
const suppressAgentReplyAttribution = activeConv.type === 'owned-agent';
```

- [ ] **Step 2: Pass the option to `buildReplyAttribution`**

Replace:

```ts
() => buildReplyAttribution(transcriptMessages, activeTranscriptLiveTurn, {
  inferLatestHumanRequest: inferLatestHumanReplyTarget,
}),
[activeTranscriptLiveTurn, inferLatestHumanReplyTarget, transcriptMessages],
```

with:

```ts
() => buildReplyAttribution(transcriptMessages, activeTranscriptLiveTurn, {
  inferLatestHumanRequest: inferLatestHumanReplyTarget,
  suppressAgentReplyAttribution,
}),
[activeTranscriptLiveTurn, inferLatestHumanReplyTarget, suppressAgentReplyAttribution, transcriptMessages],
```

- [ ] **Step 3: Run typecheck**

Run:

```bash
pnpm --dir app/desktop typecheck
```

Expected: pass.

---

### Task 4: Add markup regression tests for the self-agent rendering path

**Files:**
- Modify: `app/desktop/tests/desktopTranscriptAdapter.test.tsx`

- [ ] **Step 1: Add self-agent no-quote/no-reply-line markup test**

Append this test after `desktop transcript maps plain completed assistant replies to foldable sourced turn cards`:

```ts
test('self-agent chat can render completed assistant replies without reply quote or request reply line', () => {
  const messages: DesktopChatMessage[] = [
    {
      role: 'user',
      sender: 'Me',
      text: 'check again',
      timeLabel: '17:10',
      timestampMs: 1,
    },
    {
      role: 'assistant',
      sender: 'My Kordi',
      text: 'There is still no substantive progress.',
      timeLabel: '17:10',
      timestampMs: 2,
    },
  ];

  const mapped = mapDesktopMessagesForTranscript('session-self-agent', messages);
  const attributed = buildReplyAttribution(mapped, null, {
    inferLatestHumanRequest: false,
    suppressAgentReplyAttribution: true,
  }).messages;

  const requestMarkup = renderToStaticMarkup(createElement(MessageBubble, { msg: attributed[0] }));
  const assistantMarkup = renderToStaticMarkup(createElement(MessageBubble, { msg: attributed[1] }));

  assert.doesNotMatch(requestMarkup, /app-message-reply-line/);
  assert.doesNotMatch(assistantMarkup, /app-source-message-quote/);
  assert.match(assistantMarkup, /app-live-assistant-answer/);
  assert.match(assistantMarkup, /There is still no substantive progress/);
});
```

- [ ] **Step 2: Run the focused tests**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/desktopTranscriptAdapter.test.tsx tests/replyAttribution.test.tsx
```

Expected: pass.

---

### Task 5: Full verification and commit

**Files:**
- Modified files from Tasks 1-4.

- [ ] **Step 1: Run targeted regression tests**

Run:

```bash
pnpm --dir app/desktop exec tsx --test \
  tests/replyAttribution.test.tsx \
  tests/desktopTranscriptAdapter.test.tsx \
  tests/transcriptDensity.test.tsx
```

Expected: all pass.

- [ ] **Step 2: Run typecheck**

Run:

```bash
pnpm --dir app/desktop typecheck
```

Expected: pass.

- [ ] **Step 3: Run whitespace check**

Run:

```bash
git diff --check
```

Expected: no output.

- [ ] **Step 4: Commit**

Run:

```bash
git add \
  app/desktop/src/features/chat/replyAttribution.ts \
  app/desktop/src/pages/ChatsPage.tsx \
  app/desktop/tests/replyAttribution.test.tsx \
  app/desktop/tests/desktopTranscriptAdapter.test.tsx

git commit -m "fix: simplify self-agent chat replies"
```

---

## Self-review checklist

- Spec coverage:
  - Direct self-agent Agent chats suppress quote/reply-line chrome: Task 2 + Task 3 + Task 4.
  - Other session types keep attribution: suppression is opt-in and passed only when `activeConv.type === 'owned-agent'`.
  - Runtime metadata remains: no changes to `LiveChatTurnCard`, `FoldableToolTimeline`, or answer rendering.
  - Copy/feedback/expand/actions remain: no changes to action controls.
- Placeholder scan: no TBD/TODO placeholders.
- Type consistency: the option is named `suppressAgentReplyAttribution` everywhere.

Plan complete and saved to `docs/superpowers/plans/2026-06-01-self-agent-chat-simple-ui.md`.
