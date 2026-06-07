# Quote and Forward Message Context Menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Telegram-style Reply/Quote and Forward from the message context menu, with structured canonical/Cloud persistence so both the UI and agent model context understand quoted and forwarded message relationships.

**Architecture:** Add a small message-action metadata layer shared by UI, canonical sends, Cloud direct sends, Cloud group envelopes, and model prompt rendering. The UI keeps Telegram semantics: menu label **Reply** creates a quote/reply composer preview; **Forward** opens a destination picker and sends a forwarded message card. Persistence uses existing `session_messages.parent_message_id` plus `content_json.messageAction` / `content_json.replyToMessageId` / `content_json.forwardedFrom`; Cloud group controls are extended with the same metadata, while direct Cloud messages use a new body envelope with plaintext fallback parsing.

**Tech Stack:** React + TypeScript desktop UI, Tauri/Rust canonical SQLite storage, Cloud Rust server/Postgres, existing Cloud message body/envelope transports, Node `tsx` tests, Rust `cargo test`.

---

## Code review findings

### Current menu/UI state
- `app/desktop/src/kordi-app/components/transcript.tsx`
  - `MessageContextMenuContent` already renders **Reply**, **Forward**, and other options, but Reply/Forward only call `onClose`.
  - `MessageContextMenuHost` owns menu open/close locally and receives only `msg`, so action callbacks need to be added and threaded from `ChatsPage`.
  - Menu typography/placement from #551 must not regress: labels/read rows stay 10px and menu remains close to the bubble.
- `app/desktop/src/pages/ChatsPage.tsx`
  - Renders `MessageBubble` for each transcript message.
  - Already computes `attributedTranscriptMessages` through `buildReplyAttribution`.
  - Composer input is inline in this file; quote preview should render above the textarea inside `.app-composer-input`, similar to Telegram.

### Existing reply logic when agent replies to human
- `app/desktop/src/features/chat/replyAttribution.ts`
  - Current reply attribution is agent-response-oriented.
  - It identifies human request messages, then links agent messages/live turns via explicit `replyToMessageId`, `turn.replyToMessageId`, source refs, or inference.
  - It adds `sourceMessage` to agent messages so `SourceMessageQuote` renders inside the assistant response, and adds `replySummary` to the human request so the UI shows reply counts.
  - It suppresses source quote chrome for direct self-agent chats through `shouldSuppressAgentReplyAttribution`.
- This logic should not be replaced. Quote/reply for human-authored messages should reuse the same source-reference UI primitive, but should be driven by explicit metadata, not inference.

### Current persistence and read model
- `app/desktop/src/features/chat/messageActions/optimistic.ts`
  - `prepareCanonicalUserMessage(...)` creates canonical user rows with `parentMessageId: null` and content `{ sender, timeLabel, timestampMs, attachments, mentions }`.
  - This is the best insertion point for quote metadata on all canonical user sends.
- `app/desktop/src/features/canonical/readModel/messageMapping.ts`
  - Maps canonical `content_json.replyToMessageId`/`parent_message_id` only for agent-turns today.
  - Human messages ignore `replyToMessageId`, so quoted human replies will not render until this is extended.
- `app/desktop/src-tauri/src/canonical_sessions/schema.rs`
  - `session_messages` already has `parent_message_id` and flexible `content_json`; no schema migration is needed for MVP.
- `app/desktop/src-tauri/src/canonical_sessions/prompt_context.rs`
  - `recent_session_message_lines` currently reads only `sender`, `sender_role`, `content_text`.
  - It ignores `parent_message_id` and `content_json`, so the agent model cannot understand quote/forward context yet. This must be changed.

### Cloud transport constraints
- Direct Cloud messages (`bridges/cloud-server/migrations/0004_cloud_messages.sql`) store `body TEXT`, `session_id`, and attachments. No metadata columns exist.
  - Avoid a backend migration by encoding structured direct-message metadata in a body envelope that has a safe plaintext fallback for old clients.
- Group Cloud messages (`app/desktop/src/features/cloud/cloudGroupMessages.ts`) already use `kordi-cloud-group:` JSON envelopes.
  - `CloudGroupControlEnvelope.message` currently has `id`, `text`, `replyToMessageId`, `requestId`, attachments, etc.
  - Extend this with `messageAction` metadata and parse/encode it.
- Server Cloud agent fallback (`bridges/cloud-server/src/cloud_agent_runtime/runs.rs`) reads `cloud_messages.body` for history and group envelopes for group responses.
  - It must parse quote/forward envelopes before generating prompts, otherwise model context will show raw envelope strings or miss the relationship.

---

## Metadata contract

### Canonical message action metadata
Create one reusable TypeScript type and matching Rust JSON expectations:

```ts
export type MessageActionKind = 'quote' | 'forward';

export type MessageActionSource = {
  sourceSessionId: string;
  sourceMessageId: string;
  sourceMessageKind?: string | null;
  senderLabel: string;
  textPreview: string;
  attachmentCount: number;
  createdAtMs?: number | null;
  timeLabel?: string | null;
};

export type MessageActionMetadata = {
  schemaVersion: 1;
  kind: MessageActionKind;
  source: MessageActionSource;
};
```

Canonical `AppendCanonicalMessageRequest` for Reply/Quote:

```ts
{
  parentMessageId: source.sourceSessionId === destinationSessionId ? source.sourceMessageId : null,
  content: {
    ...existingContent,
    replyToMessageId: source.sourceMessageId,
    messageAction: {
      schemaVersion: 1,
      kind: 'quote',
      source,
    },
  },
}
```

Canonical `AppendCanonicalMessageRequest` for Forward:

```ts
{
  parentMessageId: null,
  contentText: forwardedTextOrCaption,
  content: {
    ...existingContent,
    forwardedFrom: source,
    messageAction: {
      schemaVersion: 1,
      kind: 'forward',
      source,
    },
  },
}
```

Rules:
- Quote/Reply is same-session in MVP. It uses `parent_message_id` and `content_json.replyToMessageId`.
- Forward may be cross-session. It stores `sourceSessionId` and `sourceMessageId` in JSON, but does not set `parent_message_id` unless the destination is the same session and we intentionally want a reply graph. MVP should keep forward separate from reply graph.
- `content_text` remains human-readable text. For forwarded text with no caption, use the forwarded source text as `content_text` so search, old UI, and model history still have useful text.
- For attachments: MVP preserves a source snapshot and forwards attachment references only if the existing send path can carry them. If not, forward text and attachment count, then track rich attachment forwarding separately.

### Direct Cloud body envelope
Create a direct Cloud envelope for Quote/Forward body metadata:

```ts
const CLOUD_DIRECT_MESSAGE_PREFIX = 'kordi-cloud-message:';

type CloudDirectMessageEnvelope = {
  schemaVersion: 1;
  kind: 'message';
  text: string;
  messageAction?: MessageActionMetadata | null;
};
```

Encoding keeps old-server compatibility because the server still stores a string body:

```ts
export function encodeCloudDirectMessageEnvelope(input: CloudDirectMessageEnvelope): string {
  return `${CLOUD_DIRECT_MESSAGE_PREFIX}${base64Url(JSON.stringify(input))}`;
}

export function parseCloudDirectMessageEnvelope(body: string): CloudDirectMessageEnvelope | null {
  // only parse prefix; otherwise return null and treat body as plain text
}

export function cloudDirectMessageDisplayText(body: string): string {
  return parseCloudDirectMessageEnvelope(body)?.text ?? body;
}
```

Cloud server agent runtime must mirror this parser in Rust so direct-agent history sees text plus quote/forward context.

### Group Cloud envelope extension
Extend `CloudGroupControlEnvelope.message`:

```ts
message?: {
  id: string;
  senderAccountId: string;
  text: string;
  createdAtMs: number;
  // existing fields...
  messageAction?: MessageActionMetadata | null;
}
```

Group receive writes this metadata into canonical `content_json.messageAction`; Quote uses `replyToMessageId`/`parentMessageId` if present.

---

## Task 1: Add shared message-action metadata helpers

**Files:**
- Create: `app/desktop/src/features/chat/messageActionMetadata.ts`
- Test: `app/desktop/tests/messageActionMetadata.test.ts`

- [ ] **Step 1: Write failing tests for source extraction and metadata construction**

Create `app/desktop/tests/messageActionMetadata.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  messageActionSourceFromMessage,
  quoteMessageAction,
  forwardMessageAction,
  messageActionPreviewText,
} from '../src/features/chat/messageActionMetadata';
import type { Message } from '../src/kordi-app/types';

const sourceMessage: Message = {
  id: 'msg:source',
  entryId: 'msg:source-entry',
  role: 'person',
  sender: 'Alice',
  senderType: 'human',
  text: 'Can we ship the concise version?',
  time: '10:42',
  attachments: [{ kind: 'file', name: 'brief.pdf' }],
};

test('messageActionSourceFromMessage captures stable quote source for model-readable metadata', () => {
  const source = messageActionSourceFromMessage(sourceMessage, 'session:group:one');
  assert.deepEqual(source, {
    sourceSessionId: 'session:group:one',
    sourceMessageId: 'msg:source',
    sourceMessageKind: 'text',
    senderLabel: 'Alice',
    textPreview: 'Can we ship the concise version?',
    attachmentCount: 1,
    timeLabel: '10:42',
    createdAtMs: null,
  });
});

test('quoteMessageAction and forwardMessageAction create schema-versioned metadata', () => {
  const source = messageActionSourceFromMessage(sourceMessage, 'session:group:one');
  assert.equal(quoteMessageAction(source).kind, 'quote');
  assert.equal(forwardMessageAction(source).kind, 'forward');
  assert.equal(quoteMessageAction(source).schemaVersion, 1);
});

test('messageActionPreviewText prefers assistant text and truncates multi-line text', () => {
  const preview = messageActionPreviewText({
    role: 'owned-agent',
    sender: 'My Kordi',
    text: '',
    time: '10:43',
    turn: {
      id: 'turn:1',
      sessionId: 'session:one',
      prompt: '',
      status: 'complete',
      message: 'Complete',
      assistantText: 'Line one\nLine two with extra text',
      thinkingText: '',
      tools: [],
      completed: true,
      succeeded: true,
    },
  }, 16);
  assert.equal(preview, 'Line one Line tw…');
});
```

- [ ] **Step 2: Run test and confirm it fails**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/messageActionMetadata.test.ts
```

Expected: FAIL because `messageActionMetadata.ts` does not exist.

- [ ] **Step 3: Implement helpers**

Create `app/desktop/src/features/chat/messageActionMetadata.ts`:

```ts
import type { Message } from '@/kordi-app/types';

export type MessageActionKind = 'quote' | 'forward';

export type MessageActionSource = {
  sourceSessionId: string;
  sourceMessageId: string;
  sourceMessageKind?: string | null;
  senderLabel: string;
  textPreview: string;
  attachmentCount: number;
  createdAtMs?: number | null;
  timeLabel?: string | null;
};

export type MessageActionMetadata = {
  schemaVersion: 1;
  kind: MessageActionKind;
  source: MessageActionSource;
};

function clean(value?: string | null): string {
  return value?.trim() ?? '';
}

export function messageActionPreviewText(message: Pick<Message, 'text' | 'turn' | 'detail' | 'attachments'>, maxChars = 220): string {
  const raw = clean(message.turn?.assistantText) || clean(message.text) || clean(message.detail);
  const normalized = raw.replace(/\s+/g, ' ').trim();
  const fallback = !normalized && (message.attachments?.length ?? 0) > 0
    ? `${message.attachments!.length} attachment${message.attachments!.length === 1 ? '' : 's'}`
    : normalized;
  if (fallback.length <= maxChars) return fallback;
  return `${fallback.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

export function messageActionSourceFromMessage(message: Message, sourceSessionId: string): MessageActionSource | null {
  const sourceMessageId = clean(message.id) || clean(message.entryId);
  const sessionId = clean(sourceSessionId);
  if (!sourceMessageId || !sessionId) return null;
  const senderLabel = clean(message.sender) || (message.isOwnMessage ? 'You' : message.role === 'owned-agent' ? 'My Kordi' : message.role);
  return {
    sourceSessionId: sessionId,
    sourceMessageId,
    sourceMessageKind: message.turn ? 'agent-turn' : 'text',
    senderLabel,
    textPreview: messageActionPreviewText(message),
    attachmentCount: message.attachments?.length ?? 0,
    timeLabel: clean(message.time) || null,
    createdAtMs: null,
  };
}

export function quoteMessageAction(source: MessageActionSource): MessageActionMetadata {
  return { schemaVersion: 1, kind: 'quote', source };
}

export function forwardMessageAction(source: MessageActionSource): MessageActionMetadata {
  return { schemaVersion: 1, kind: 'forward', source };
}

export function isMessageActionMetadata(value: unknown): value is MessageActionMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const source = record.source as Record<string, unknown> | undefined;
  return record.schemaVersion === 1
    && (record.kind === 'quote' || record.kind === 'forward')
    && Boolean(source)
    && typeof source.sourceSessionId === 'string'
    && typeof source.sourceMessageId === 'string'
    && typeof source.senderLabel === 'string';
}
```

- [ ] **Step 4: Run test and commit**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/messageActionMetadata.test.ts
```

Expected: PASS.

Commit:

```bash
git add app/desktop/src/features/chat/messageActionMetadata.ts app/desktop/tests/messageActionMetadata.test.ts
git commit -m "feat: add message action metadata helpers"
```

---

## Task 2: Thread context-menu Reply and Forward callbacks through transcript UI

**Files:**
- Modify: `app/desktop/src/kordi-app/components/transcript.tsx`
- Modify: `app/desktop/src/pages/ChatsPage.tsx`
- Modify: `app/desktop/src/app/kordiShellSlots.types.ts`
- Modify: `app/desktop/src/app/mainContentShellBuilders.ts`
- Test: `app/desktop/tests/transcriptDensity.test.tsx`

- [ ] **Step 1: Write failing UI tests for menu callbacks and labels**

Add to `app/desktop/tests/transcriptDensity.test.tsx` near existing context-menu tests:

```ts
test('message context menu exposes Reply and Forward actions for eligible messages', () => {
  const message: Message = {
    id: 'msg:quote-target',
    role: 'person',
    sender: 'Alice',
    senderType: 'human',
    text: 'Quote me',
    time: '10:42',
  };
  const markup = renderToStaticMarkup(
    <MessageContextMenuContent
      msg={message}
      onClose={() => {}}
      onReplyMessage={() => {}}
      onForwardMessage={() => {}}
    />,
  );
  assert.match(markup, />Reply</);
  assert.match(markup, />Forward</);
  assert.match(markup, /data-message-context-menu-action="reply"/);
  assert.match(markup, /data-message-context-menu-action="forward"/);
});
```

- [ ] **Step 2: Run test and confirm it fails**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/transcriptDensity.test.tsx
```

Expected: FAIL because `MessageContextMenuContent` does not accept callbacks/action data attributes.

- [ ] **Step 3: Update transcript menu props**

In `transcript.tsx`, introduce:

```ts
export type MessageContextMenuActionHandlers = {
  onReplyMessage?: (message: Message) => void;
  onForwardMessage?: (message: Message) => void;
};
```

Update `MessageContextMenuAction`:

```tsx
function MessageContextMenuAction({
  icon,
  label,
  action,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  action: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      data-message-context-menu-action={action}
      className="app-message-context-menu-action flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[10px] font-normal leading-[1.45] text-slate-950 transition hover:bg-slate-100"
      style={messageContextMenuTextStyle}
      onClick={onClick}
    >
      <span className="grid h-4 w-4 shrink-0 place-items-center text-slate-950" aria-hidden="true">{icon}</span>
      <span>{label}</span>
    </button>
  );
}
```

Update `MessageContextMenuContent`:

```tsx
export function MessageContextMenuContent({
  msg,
  onClose,
  onReplyMessage,
  onForwardMessage,
}: {
  msg: Message;
  onClose?: () => void;
} & MessageContextMenuActionHandlers) {
  const handleReply = () => {
    onReplyMessage?.(msg);
    onClose?.();
  };
  const handleForward = () => {
    onForwardMessage?.(msg);
    onClose?.();
  };
  // ...
  <MessageContextMenuAction action="reply" icon={<Reply className="h-4 w-4" />} label="Reply" onClick={handleReply} />
  <MessageContextMenuAction action="forward" icon={<Forward className="h-4 w-4" />} label="Forward" onClick={handleForward} />
}
```

Keep labels at 10px and do not change menu physical size.

- [ ] **Step 4: Thread handlers to MessageBubble**

Add optional props to `MessageContextMenuHost`, `MessageBubbleView`, and `MessageBubble`:

```ts
onReplyMessage?: (message: Message) => void;
onForwardMessage?: (message: Message) => void;
```

Pass handlers from `MessageBubble` call sites in `ChatsPage.tsx`.

- [ ] **Step 5: Run tests and commit**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/transcriptDensity.test.tsx
```

Expected: PASS.

Commit:

```bash
git add app/desktop/src/kordi-app/components/transcript.tsx app/desktop/src/pages/ChatsPage.tsx app/desktop/src/app/kordiShellSlots.types.ts app/desktop/src/app/mainContentShellBuilders.ts app/desktop/tests/transcriptDensity.test.tsx
git commit -m "feat: wire message context menu actions"
```

---

## Task 3: Add Telegram-style quote/reply composer preview state

**Files:**
- Modify: `app/desktop/src/kordi-app/types/message.ts`
- Modify: `app/desktop/src/features/chat/composerController.types.ts`
- Modify: `app/desktop/src/app/useKordiLocalUiState.ts`
- Modify: `app/desktop/src/app/useKordiAppModel.ts`
- Modify: `app/desktop/src/pages/ChatsPage.tsx`
- Test: `app/desktop/tests/chatDetailPanel.test.tsx`

- [ ] **Step 1: Add failing test for quote preview rendering**

Add a focused render test in `app/desktop/tests/chatDetailPanel.test.tsx` using the existing ChatsPage/ChatDetailPanel render helpers. Assert that when `activeChatQuote` is provided, composer markup contains:

```ts
assert.match(markup, /data-composer-quote-preview="true"/);
assert.match(markup, /Alice/);
assert.match(markup, /Can we ship/);
assert.match(markup, /aria-label="Remove quoted message"/);
```

Expected: FAIL before state/markup exists.

- [ ] **Step 2: Define quote state type**

In `app/desktop/src/kordi-app/types/message.ts`:

```ts
import type { MessageActionSource } from '@/features/chat/messageActionMetadata';

export type ComposerQuoteState = {
  action: 'quote';
  source: MessageActionSource;
};
```

If importing from `features` into `kordi-app/types` creates an undesirable dependency, define the plain structural type in `message.ts` and keep `messageActionMetadata.ts` compatible with it.

- [ ] **Step 3: Store per-chat quote draft state**

In `useKordiLocalUiState.ts`, add:

```ts
const [chatQuoteBySessionId, setChatQuoteBySessionId] = useState<Record<string, ComposerQuoteState | null>>({});
```

Expose it through `composerUi`.

In `useKordiAppModel.ts`, derive:

```ts
const activeChatQuote = composerUi.chatQuoteBySessionId[chatDraftSessionId] ?? null;
```

Add handlers:

```ts
const handleReplyToMessage = useCallback((message: Message) => {
  const source = messageActionSourceFromMessage(message, activeConvCanonicalSessionId ?? activeConv.id);
  if (!source) return;
  composerUi.setChatQuoteBySessionId((current) => ({
    ...current,
    [chatDraftSessionId]: { action: 'quote', source },
  }));
  focusComposerTextareaForNativeInput(CHAT_COMPOSER_TEXTAREA_SELECTOR, isNativeShell);
}, [activeConv.id, activeConvCanonicalSessionId, chatDraftSessionId, composerUi.setChatQuoteBySessionId, isNativeShell]);

const clearActiveChatQuote = useCallback(() => {
  composerUi.setChatQuoteBySessionId((current) => ({ ...current, [chatDraftSessionId]: null }));
}, [chatDraftSessionId, composerUi.setChatQuoteBySessionId]);
```

- [ ] **Step 4: Render Telegram-style composer quote preview**

In `ChatsPage.tsx`, render above attachments/textarea inside `.app-composer-input`:

```tsx
{activeChatQuote ? (
  <div data-composer-quote-preview="true" className="mb-1.5 flex items-start gap-2 rounded-[14px] border border-sky-300/20 bg-sky-400/10 px-2.5 py-2 text-left">
    <span className="mt-0.5 h-8 w-0.5 shrink-0 rounded-full bg-sky-300" aria-hidden="true" />
    <div className="min-w-0 flex-1">
      <div className="truncate text-[11px] font-semibold text-sky-200">{activeChatQuote.source.senderLabel}</div>
      <div className="truncate text-[11px] text-slate-300">{activeChatQuote.source.textPreview || `${activeChatQuote.source.attachmentCount} attachment${activeChatQuote.source.attachmentCount === 1 ? '' : 's'}`}</div>
    </div>
    <button type="button" aria-label="Remove quoted message" onClick={onClearChatQuote} className="grid h-5 w-5 shrink-0 place-items-center rounded-full text-slate-400 transition hover:bg-white/10 hover:text-white">
      <X className="h-3.5 w-3.5" />
    </button>
  </div>
) : null}
```
- [ ] **Step 5: Clear quote after successful send**

In the existing send success path (`handleSendChatMessage` / composer controller success callback), clear quote only after `sendChatMessage` resolves without throwing.

- [ ] **Step 6: Run tests and commit**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/chatDetailPanel.test.tsx
```

Expected: PASS.

Commit:

```bash
git add app/desktop/src/kordi-app/types/message.ts app/desktop/src/features/chat/composerController.types.ts app/desktop/src/app/useKordiLocalUiState.ts app/desktop/src/app/useKordiAppModel.ts app/desktop/src/pages/ChatsPage.tsx app/desktop/tests/chatDetailPanel.test.tsx
git commit -m "feat: add quoted reply composer preview"
```

---

## Task 4: Persist quote metadata on canonical sends

**Files:**
- Modify: `app/desktop/src/features/chat/messageActions/types.ts`
- Modify: `app/desktop/src/features/chat/messageActions/chatMessages.ts`
- Modify: `app/desktop/src/features/chat/messageActions/optimistic.ts`
- Modify: `app/desktop/src/features/chat/useComposerMessageActions.ts`
- Modify: `app/desktop/src/features/chat/useComposerController.ts`
- Test: `app/desktop/tests/chatMessageActions.test.ts` or add focused coverage to existing send tests

- [ ] **Step 1: Write failing test for quote metadata in canonical append request**

Add a test around `prepareCanonicalUserMessage(...)`:

```ts
const prepared = prepareCanonicalUserMessage({
  sessionId: 'session:one',
  text: 'Yes, ship it',
  nowMs: 1_720_000_000_000,
  sender: { kind: 'self', label: 'You' },
  attachments: [],
  mentions: [],
  quote: {
    action: 'quote',
    source: {
      sourceSessionId: 'session:one',
      sourceMessageId: 'msg:source',
      senderLabel: 'Alice',
      textPreview: 'Can we ship?',
      attachmentCount: 0,
      createdAtMs: null,
      timeLabel: '10:42',
    },
  },
});

assert.equal(prepared.parentMessageId, 'msg:source');
assert.equal(prepared.content.replyToMessageId, 'msg:source');
assert.equal(prepared.content.messageAction.kind, 'quote');
```

- [ ] **Step 2: Run test and confirm it fails**

Run the focused suite containing the new test.

- [ ] **Step 3: Extend send request types**

Add optional quote metadata:

```ts
export type SendChatMessageInput = {
  // existing
  quote?: ComposerQuoteState | null;
};
```

Thread `activeChatQuote` from `ChatsPage` -> composer controller -> `useComposerMessageActions` -> `sendChatMessage` -> `prepareCanonicalUserMessage`.

- [ ] **Step 4: Update `prepareCanonicalUserMessage`**

In `optimistic.ts`, add `quote?: ComposerQuoteState | null` to the input and persist:

```ts
const quoteAction = quote?.source ? quoteMessageAction(quote.source) : null;
const sameSessionQuote = quoteAction?.source.sourceSessionId === sessionId;

return {
  // existing
  parentMessageId: quoteAction && sameSessionQuote ? quoteAction.source.sourceMessageId : null,
  content: {
    ...existingContent,
    ...(quoteAction ? {
      replyToMessageId: quoteAction.source.sourceMessageId,
      messageAction: quoteAction,
    } : null),
  },
};
```

- [ ] **Step 5: Run tests and commit**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/chatMessageActions.test.ts tests/chatDetailPanel.test.tsx
```

If `chatMessageActions.test.ts` does not exist, run the actual focused file where the test was added.

Commit:

```bash
git add app/desktop/src/features/chat/messageActions/types.ts app/desktop/src/features/chat/messageActions/chatMessages.ts app/desktop/src/features/chat/messageActions/optimistic.ts app/desktop/src/features/chat/useComposerMessageActions.ts app/desktop/src/features/chat/useComposerController.ts app/desktop/tests
git commit -m "feat: persist quoted reply metadata"
```

---

## Task 5: Render quoted human replies from explicit metadata

**Files:**
- Modify: `app/desktop/src/features/canonical/readModel/messageMapping.ts`
- Modify: `app/desktop/src/features/chat/replyAttribution.ts`
- Modify: `app/desktop/src/kordi-app/components/transcriptReplyAttribution.tsx` if needed
- Test: `app/desktop/tests/replyAttribution.test.tsx`

- [ ] **Step 1: Write failing read-model/reply-attribution test**

In `replyAttribution.test.tsx`, add a case with a human message containing:

```ts
content_json: {
  sender: { kind: 'self', label: 'You' },
  replyToMessageId: 'msg:alice',
  messageAction: {
    schemaVersion: 1,
    kind: 'quote',
    source: {
      sourceSessionId: 'session:one',
      sourceMessageId: 'msg:alice',
      senderLabel: 'Alice',
      textPreview: 'Original question',
      attachmentCount: 0,
    },
  },
}
```

Assert the mapped message has `sourceMessage` or equivalent quote display data and the original message receives `replySummary`.

- [ ] **Step 2: Run test and confirm it fails**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/replyAttribution.test.tsx
```

- [ ] **Step 3: Extend mapping**

In `messageMapping.ts`, when `content_json.messageAction.kind === 'quote'`:
- Set `message.replyToMessageId` from metadata source.
- Set `message.sourceMessage` to a lightweight snapshot if the source row is not in loaded messages:

```ts
sourceMessage: {
  id: source.sourceMessageId,
  role: 'person',
  sender: source.senderLabel,
  text: source.textPreview,
  time: source.timeLabel ?? '',
}
```

- Preserve existing agent-turn attribution fields.

- [ ] **Step 4: Update `replyAttribution.ts` to accept explicit human quote actions**

Add a non-invasive path:
- Build a map of transcript messages by id.
- For any message with `messageAction.kind === 'quote'` or `replyToMessageId`, attach source from the transcript map or metadata snapshot.
- Increment `replySummary.count` on the source message.
- Do not apply agent-inference suppression to explicit human quotes.

- [ ] **Step 5: Run tests and commit**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/replyAttribution.test.tsx tests/chatDetailPanel.test.tsx
```

Commit:

```bash
git add app/desktop/src/features/canonical/readModel/messageMapping.ts app/desktop/src/features/chat/replyAttribution.ts app/desktop/src/kordi-app/components/transcriptReplyAttribution.tsx app/desktop/tests/replyAttribution.test.tsx app/desktop/tests/chatDetailPanel.test.tsx
git commit -m "feat: render explicit quoted replies"
```

---

## Task 6: Implement Forward destination picker and send flow

**Files:**
- Create: `app/desktop/src/features/chat/messageForwarding.ts`
- Create: `app/desktop/src/pages/MessageForwardDialog.tsx`
- Modify: `app/desktop/src/pages/ChatsPage.tsx`
- Modify: `app/desktop/src/app/useKordiAppModel.ts`
- Modify: `app/desktop/src/features/chat/messageActions/chatMessages.ts`
- Test: `app/desktop/tests/messageForwarding.test.tsx`

- [ ] **Step 1: Write failing tests for forward payload creation**

Create `app/desktop/tests/messageForwarding.test.tsx`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { createForwardedMessageDraft } from '../src/features/chat/messageForwarding';

const source = {
  sourceSessionId: 'session:one',
  sourceMessageId: 'msg:source',
  senderLabel: 'Alice',
  textPreview: 'Forward this',
  attachmentCount: 0,
  createdAtMs: null,
  timeLabel: '10:42',
};

test('createForwardedMessageDraft stores forwardedFrom metadata and text fallback', () => {
  const draft = createForwardedMessageDraft({ source, caption: '', destinationSessionId: 'session:two' });
  assert.equal(draft.text, 'Forward this');
  assert.equal(draft.messageAction.kind, 'forward');
  assert.deepEqual(draft.forwardedFrom, source);
});

test('createForwardedMessageDraft keeps user caption while preserving source metadata', () => {
  const draft = createForwardedMessageDraft({ source, caption: 'FYI', destinationSessionId: 'session:two' });
  assert.equal(draft.text, 'FYI');
  assert.equal(draft.messageAction.source.sourceMessageId, 'msg:source');
});
```

- [ ] **Step 2: Run test and confirm it fails**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/messageForwarding.test.tsx
```

- [ ] **Step 3: Implement forward draft helpers**

In `messageForwarding.ts`:

```ts
import { forwardMessageAction, type MessageActionSource } from './messageActionMetadata';

export function createForwardedMessageDraft({
  source,
  caption,
}: {
  source: MessageActionSource;
  caption?: string;
  destinationSessionId: string;
}) {
  const text = caption?.trim() || source.textPreview || `${source.attachmentCount} attachment${source.attachmentCount === 1 ? '' : 's'}`;
  const messageAction = forwardMessageAction(source);
  return {
    text,
    forwardedFrom: source,
    messageAction,
  };
}
```

- [ ] **Step 4: Add destination picker UI**

Create `MessageForwardDialog.tsx`:
- Modal/dialog title: `Forward message`.
- Search input.
- Dense list of eligible destinations:
  - Recent canonical conversations.
  - Cloud contacts/direct chats.
  - Groups.
  - Agents/sessions if they are valid send targets.
- Single-select MVP.
- Optional caption textarea.
- Primary button: `Forward`.
- Keyboard: Escape closes; Enter confirms when one destination selected.

Important Telegram-like behavior:
- Context menu closes immediately when **Forward** is clicked.
- Forward dialog appears centered/overlayed.
- Original message bubble remains unchanged.
- After sending, navigate/open destination chat only if current product already does this for new messages; otherwise leave current chat and show toast.

- [ ] **Step 5: Wire forward send path**

In `useKordiAppModel.ts`:
- `handleForwardMessage(message)` creates a `MessageActionSource` and opens the dialog with it.
- `handleConfirmForward(destination, caption)` calls the appropriate existing send path for the destination.

In canonical `sendChatMessage`, allow optional `forward` metadata similar to quote:

```ts
content: {
  ...existingContent,
  forwardedFrom: forward.source,
  messageAction: forwardMessageAction(forward.source),
}
```

For current-session forwarding, do **not** set `parentMessageId`.

- [ ] **Step 6: Render forwarded message card**

In transcript rendering, if `messageAction.kind === 'forward'`, render a compact preface above content:

```tsx
<div data-message-forwarded-from="true" className="mb-1 text-[11px] font-medium text-sky-200">
  Forwarded from {message.messageAction.source.senderLabel}
</div>
```

Optionally render the source text as a small quote block when the visible `message.text` is only a caption.

- [ ] **Step 7: Run tests and commit**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/messageForwarding.test.tsx tests/chatDetailPanel.test.tsx tests/transcriptDensity.test.tsx
```

Commit:

```bash
git add app/desktop/src/features/chat/messageForwarding.ts app/desktop/src/pages/MessageForwardDialog.tsx app/desktop/src/pages/ChatsPage.tsx app/desktop/src/app/useKordiAppModel.ts app/desktop/src/features/chat/messageActions/chatMessages.ts app/desktop/tests/messageForwarding.test.tsx app/desktop/tests/chatDetailPanel.test.tsx app/desktop/tests/transcriptDensity.test.tsx
git commit -m "feat: forward messages between chats"
```

---

## Task 7: Add direct Cloud quote/forward envelopes

**Files:**
- Modify: `app/desktop/src/features/cloud/authClient.ts`
- Modify: `app/desktop/src/features/cloud/cloudBridgeState.ts`
- Modify: `app/desktop/src/features/chat/messageActions/chatMessages.ts`
- Test: `app/desktop/tests/cloudDirectContactSend.test.ts`
- Test: `app/desktop/tests/cloudBridgeState.test.tsx`

- [ ] **Step 1: Write failing tests for direct Cloud envelope encode/decode**

In `cloudBridgeState.test.tsx` or a new `cloudDirectMessageEnvelope.test.ts`:

```ts
const encoded = encodeCloudDirectMessageEnvelope({
  schemaVersion: 1,
  kind: 'message',
  text: 'Replying with context',
  messageAction: quoteMessageAction(source),
});
assert.equal(cloudDirectMessageDisplayText(encoded), 'Replying with context');
assert.equal(parseCloudDirectMessageEnvelope(encoded)?.messageAction?.kind, 'quote');
assert.equal(cloudDirectMessageDisplayText('plain body'), 'plain body');
```

- [ ] **Step 2: Run tests and confirm they fail**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/cloudBridgeState.test.tsx tests/cloudDirectContactSend.test.ts
```

- [ ] **Step 3: Implement direct envelope helpers**

Add to `authClient.ts` or better `cloudDirectMessages.ts`:

```ts
export const CLOUD_DIRECT_MESSAGE_PREFIX = 'kordi-cloud-message:';
export type CloudDirectMessageEnvelope = {
  schemaVersion: 1;
  kind: 'message';
  text: string;
  messageAction?: MessageActionMetadata | null;
};
```

Implement `encodeCloudDirectMessageEnvelope`, `parseCloudDirectMessageEnvelope`, `cloudDirectMessageDisplayText`, and `cloudDirectMessageAction`.

- [ ] **Step 4: Use envelope when sending metadata**

When direct Cloud send has `quote` or `forward` metadata:
- Encode body as envelope.
- Keep attachments unchanged.
- Keep session ID unchanged.
- Plain sends remain plain text to minimize risk.

- [ ] **Step 5: Parse envelope on receive**

In `cloudBridgeState.ts`:
- Display `envelope.text`.
- Persist `content_json.messageAction` for canonical direct messages.
- If quote, persist `replyToMessageId` and `parentMessageId` when same canonical session.

- [ ] **Step 6: Run tests and commit**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/cloudDirectContactSend.test.ts tests/cloudBridgeState.test.tsx
```

Commit:

```bash
git add app/desktop/src/features/cloud/authClient.ts app/desktop/src/features/cloud/cloudBridgeState.ts app/desktop/src/features/chat/messageActions/chatMessages.ts app/desktop/tests/cloudDirectContactSend.test.ts app/desktop/tests/cloudBridgeState.test.tsx
git commit -m "feat: carry direct cloud message action metadata"
```

---

## Task 8: Add group Cloud quote/forward metadata

**Files:**
- Modify: `app/desktop/src/features/cloud/cloudGroupMessages.ts`
- Modify: `app/desktop/src/features/cloud/useCloudBridgeState.ts`
- Test: `app/desktop/tests/cloudGroupMessages.test.tsx`

- [ ] **Step 1: Write failing group envelope tests**

In `cloudGroupMessages.test.tsx`:
- Encode a group message with `messageAction.kind === 'quote'` and assert parse preserves it.
- Encode a group message with `messageAction.kind === 'forward'` and assert parse preserves it.
- Assert receive/persist converts quote to `replyToMessageId` and `parentMessageId` for same group session.

- [ ] **Step 2: Run tests and confirm they fail**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/cloudGroupMessages.test.tsx
```

- [ ] **Step 3: Extend group message types and builders**

In `cloudGroupMessages.ts`, add:

```ts
messageAction?: MessageActionMetadata | null;
```

to group message payload types, parser, and encoder.

When sending a quote in a group:
- Preserve existing `replyToMessageId` field.
- Also set `messageAction: { kind: 'quote', ... }` for model-readable metadata.

When forwarding in a group:
- Set `messageAction.kind = 'forward'`.
- Do not set `replyToMessageId` unless it is intentionally a reply.

- [ ] **Step 4: Persist group metadata on receive**

In `useCloudBridgeState.ts`, when normalizing group messages to canonical rows, write `content_json.messageAction`, `forwardedFrom`, `replyToMessageId`, and `parentMessageId` as appropriate.

- [ ] **Step 5: Run tests and commit**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/cloudGroupMessages.test.tsx
```

Commit:

```bash
git add app/desktop/src/features/cloud/cloudGroupMessages.ts app/desktop/src/features/cloud/useCloudBridgeState.ts app/desktop/tests/cloudGroupMessages.test.tsx
git commit -m "feat: carry group message action metadata"
```

---

## Task 9: Make canonical prompt context model-readable

**Files:**
- Modify: `app/desktop/src-tauri/src/canonical_sessions/prompt_context.rs`
- Test: Rust unit tests in `prompt_context.rs` or existing canonical session tests

- [ ] **Step 1: Add failing Rust tests**

In `prompt_context.rs` test module, add tests for formatting recent history lines:

```rust
#[test]
fn recent_message_line_includes_quote_context() {
    let content_json = serde_json::json!({
        "messageAction": {
            "schemaVersion": 1,
            "kind": "quote",
            "source": {
                "sourceSessionId": "session:one",
                "sourceMessageId": "msg:source",
                "senderLabel": "Alice",
                "textPreview": "Original question",
                "attachmentCount": 0
            }
        }
    });
    let line = format_recent_session_message_line("You", "user", "Yes", Some("msg:source"), Some(&content_json));
    assert!(line.contains("replied to Alice"));
    assert!(line.contains("Original question"));
    assert!(line.contains("Yes"));
}

#[test]
fn recent_message_line_includes_forward_context() {
    let content_json = serde_json::json!({
        "messageAction": {
            "schemaVersion": 1,
            "kind": "forward",
            "source": {
                "sourceSessionId": "session:other",
                "sourceMessageId": "msg:source",
                "senderLabel": "Alice",
                "textPreview": "Forward this",
                "attachmentCount": 0
            }
        }
    });
    let line = format_recent_session_message_line("You", "user", "Forward this", None, Some(&content_json));
    assert!(line.contains("forwarded from Alice"));
    assert!(line.contains("Forward this"));
}
```

If such helper does not exist, first extract the existing inline format to `format_recent_session_message_line` and test it.

- [ ] **Step 2: Run test and confirm it fails**

Run:

```bash
cargo test -p kordi-desktop canonical_sessions::prompt_context -- --nocapture
```

Adjust crate name if `cargo metadata` shows a different package name.

- [ ] **Step 3: Query content metadata**

Change the SQL in `recent_session_message_lines` from:

```sql
SELECT sender, sender_role, content_text
```

to include:

```sql
SELECT sender, sender_role, content_text, parent_message_id, content_json
```

Parse `content_json` into `serde_json::Value`.

- [ ] **Step 4: Format model-readable quote/forward lines**

Add formatting rules:

```text
Alice (user): Can we ship?
You (user) replied to Alice [source message msg:source]: "Can we ship?" — Yes, ship it
You (user) forwarded from Alice [source session session:other, message msg:source]: "Forward this"
```

Rules:
- Keep the existing plain format if metadata is missing/invalid.
- Include stable source IDs in brackets, because the model can reason over them.
- Truncate source preview and body to reasonable lengths to avoid prompt blowups.
- Do not render raw JSON.

- [ ] **Step 5: Run tests and commit**

Run:

```bash
cargo test -p kordi-desktop canonical_sessions::prompt_context -- --nocapture
```

Commit:

```bash
git add app/desktop/src-tauri/src/canonical_sessions/prompt_context.rs
git commit -m "feat: include message action context in prompts"
```

---

## Task 10: Make Cloud server fallback prompts understand envelopes

**Files:**
- Modify: `bridges/cloud-server/src/cloud_agent_runtime/runs.rs`
- Test: existing `runs.rs` unit tests or `bridges/cloud-server/tests/cloud_agent_runtime_e2e.rs`

- [ ] **Step 1: Add failing unit tests**

In `runs.rs` tests, add:

```rust
#[test]
fn fallback_history_line_decodes_direct_quote_envelope() {
    let body = encode_direct_test_envelope("Yes", "quote", "Alice", "Original");
    let line = fallback_prompt_history_line("requester", "owner", &CloudFallbackHistoryMessage {
        from_account_id: "requester".to_string(),
        body,
    }).unwrap();
    assert!(line.contains("Requester replied to Alice"));
    assert!(line.contains("Original"));
    assert!(line.contains("Yes"));
}

#[test]
fn fallback_history_line_decodes_group_forward_envelope() {
    // Use existing CloudGroupEnvelope with messageAction.kind = forward.
    // Assert text says forwarded from Alice and not raw kordi-cloud-group prefix.
}
```

- [ ] **Step 2: Run tests and confirm they fail**

Run:

```bash
cargo test -p cloud-server cloud_agent_runtime::runs -- --nocapture
```

- [ ] **Step 3: Mirror direct envelope parser in Rust**

In `runs.rs`:

```rust
const CLOUD_DIRECT_MESSAGE_PREFIX: &str = "kordi-cloud-message:";

#[derive(Debug, Deserialize)]
struct CloudDirectMessageEnvelope { /* schema_version, kind, text, message_action */ }
#[derive(Debug, Deserialize)]
struct CloudMessageActionMetadata { /* schema_version, kind, source */ }
#[derive(Debug, Deserialize)]
struct CloudMessageActionSource { /* source_session_id, source_message_id, sender_label, text_preview, attachment_count */ }
```

Use serde renames for camelCase.

- [ ] **Step 4: Extend group envelope structs**

Add `message_action: Option<CloudMessageActionMetadata>` to `CloudGroupMessage` with serde rename.

- [ ] **Step 5: Format fallback history with context**

Update `fallback_prompt_history_line`:
- Decode direct envelope first.
- Decode Cloud group envelope for group-session bodies and use `message.text` instead of raw body.
- For quote action:

```text
Requester replied to Alice [source message msg:source]: "Original" — Yes
```

- For forward action:

```text
Requester forwarded from Alice [source session session:other, message msg:source]: "Forward this"
```

Keep existing `kordi-cloud-agent-response:` handling for owner agent responses.

- [ ] **Step 6: Run tests and commit**

Run:

```bash
cargo test -p cloud-server cloud_agent_runtime::runs -- --nocapture
```

Commit:

```bash
git add bridges/cloud-server/src/cloud_agent_runtime/runs.rs
git commit -m "feat: decode message action context for cloud prompts"
```

---

## Task 11: Integration and regression pass

- [ ] **Step 1: Run targeted desktop tests**

```bash
pnpm --dir app/desktop exec tsx --test \
  tests/messageActionMetadata.test.ts \
  tests/messageForwarding.test.tsx \
  tests/replyAttribution.test.tsx \
  tests/chatDetailPanel.test.tsx \
  tests/transcriptDensity.test.tsx \
  tests/cloudDirectContactSend.test.ts \
  tests/cloudBridgeState.test.tsx \
  tests/cloudGroupMessages.test.tsx
```

Expected: PASS.

- [ ] **Step 2: Run desktop typecheck**

```bash
pnpm --dir app/desktop typecheck
```

Expected: PASS.

- [ ] **Step 3: Run Rust focused tests**

```bash
cargo test -p kordi-desktop canonical_sessions::prompt_context -- --nocapture
cargo test -p cloud-server cloud_agent_runtime::runs -- --nocapture
```

Expected: PASS.

- [ ] **Step 4: Run diff hygiene**

```bash
git diff --check
```

Expected: PASS.

- [ ] **Step 5: Manual verification with local preview**

Use the existing Cloud multi-instance flow if needed:

```bash
pnpm --dir app/desktop dev:cloud:multi -- --config scripts/multi-instance/configs/users.yaml
```

Manual checks:
- Right-click any message: menu remains Telegram-dense, close to bubble, labels at 10px.
- Click Reply: composer shows quote preview, focuses textarea, cancel X removes it.
- Send quoted reply: bubble shows quote source, DB `content_json.messageAction.kind` is `quote`, `parent_message_id` is set for same-session quote.
- Agent response to quoted human request still uses existing agent reply attribution and does not regress.
- Click Forward: destination picker opens, can select contact/group/session, send creates a forwarded message card.
- Receiving peer sees forwarded/quoted metadata and UI card.
- Cloud group messages preserve quote/forward metadata.
- Agent prompt context includes readable quote/forward context instead of raw JSON/envelope.

- [ ] **Step 6: Final commit if any verification fixes were made**

```bash
git status --short
git add <changed-files>
git commit -m "fix: polish message action integration"
```

---

## Risk notes and implementation boundaries

- **No DB migration required for MVP.** Use existing `session_messages.parent_message_id`, `content_json`, and Cloud `body TEXT` envelopes.
- **Do not break existing agent reply attribution.** Explicit quote metadata is additive; existing inferred agent-response attribution remains.
- **Do not display read receipts inline again.** This work only wires Reply/Forward actions; #550 read info stays in the context menu.
- **Plain messages should remain plain Cloud bodies** unless quote/forward metadata is present. This limits compatibility risk.
- **Direct Cloud envelope parsing must be tolerant.** Unknown/malformed envelopes should display raw body or safe fallback, never crash.
- **Forward attachments may be staged.** If existing attachment forwarding is non-trivial, keep MVP to text + attachment count/source snapshot and file a follow-up for binary attachment duplication.
- **Cloud-only host policy:** keep docs/PR language product-facing (`https://coordinar.io`) and do not expose private operator/dev host details.

