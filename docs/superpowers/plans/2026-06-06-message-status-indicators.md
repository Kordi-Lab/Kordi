# Message Status Indicators Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship compact outgoing-message status indicators: animated sending clock, gray single check for sent/delivered, double check for read/agent-complete, and group read footer only when at least one recipient has read.

**Architecture:** Keep status rendering centralized in `features/chat/deliveryStatus.ts` and `kordi-app/components/transcript.tsx`. Preserve existing canonical/cloud message flow by adding read-receipt summary metadata to canonical message content, then mapping it to the UI `Message` model. Avoid backend/schema changes because Cloud message records already expose `deliveredAt` and `readAt` per outgoing recipient copy.

**Tech Stack:** React 19, Lucide icons, Tailwind utility classes, Node test runner via `tsx --test`, existing Cloud/canonical TypeScript read models.

---

## Current Code Map

- `app/desktop/src/features/chat/deliveryStatus.ts`
  - Maps normalized message status strings to glyph/tone/label.
  - Currently maps `delivered` to gray double-check and `read`/`responded` to blue double-check.
- `app/desktop/src/kordi-app/components/transcript.tsx`
  - Renders `MessageDeliveryGlyph`, stable footer slot, and outgoing bubble footer.
  - Currently has all glyphs pre-rendered with opacity toggles, but only spinner animates.
- `app/desktop/src/kordi-app/types/message.ts`
  - Defines the UI `Message` shape; no read-receipt summary exists yet.
- `app/desktop/src/features/cloud/cloudGroupMessages.ts`
  - `cloudGroupDeliveryStateFromMessages` derives `delivered | read` for outbound group messages from outgoing Cloud copies.
- `app/desktop/src/features/cloud/useCloudBridgeState.ts`
  - Applies Cloud group delivery state into canonical message `content.deliveryState`.
  - This is the correct place to also write canonical `content.readReceiptSummary`.
- `app/desktop/src/features/canonical/readModel/messageMapping.ts`
  - Maps canonical message content into UI `Message`; this should map `content.readReceiptSummary` into `message.readReceiptSummary`.
- Tests to modify/add:
  - `app/desktop/tests/deliveryStatus.test.tsx`
  - `app/desktop/tests/transcriptDensity.test.tsx`
  - `app/desktop/tests/cloudGroupMessages.test.tsx`
  - `app/desktop/tests/cloudBridgeState.test.tsx`

## Behavioral Rules

1. `sending` / `pending_send`: show an animated clock.
2. `sent` / `delivered`: show gray single check.
3. `read` / `responded`: show double check. Keep it quiet/gray so direct/group/agent status language is consistent.
4. `processing` and bridge handoff states: keep spinner for non-human-processing states.
5. Direct/group human message read semantics:
   - Single check means sent/delivered to Cloud.
   - Double check means read by the recipient(s) according to available Cloud read data.
6. Agent-session semantics:
   - Single check means message was sent and agent processing can begin soon.
   - Double check/read means the agent response finished.
7. Group read footer:
   - Render only for own human messages.
   - Render only when `readReceiptSummary.count > 0`.
   - Show compact avatars plus `Read by N`; do not show an empty `Read by 0` footer.

---

### Task 1: Update delivery-status visual contract

**Files:**
- Modify: `app/desktop/src/features/chat/deliveryStatus.ts`
- Modify: `app/desktop/tests/deliveryStatus.test.tsx`

- [ ] **Step 1: Write the failing tests**

Replace the delivered/read tests in `app/desktop/tests/deliveryStatus.test.tsx` with:

```ts
test('messageDeliveryVisual maps sent and delivered to a single gray check', () => {
  assert.deepEqual(messageDeliveryVisual('sent'), {
    glyph: 'single-check',
    tone: 'gray',
    label: 'Sent',
  });
  assert.deepEqual(messageDeliveryVisual('delivered'), {
    glyph: 'single-check',
    tone: 'gray',
    label: 'Delivered',
  });
});

test('messageDeliveryVisual maps read and responded to quiet double checks', () => {
  assert.deepEqual(messageDeliveryVisual('read'), {
    glyph: 'double-check',
    tone: 'gray',
    label: 'Read',
  });
  assert.deepEqual(messageDeliveryVisual('responded'), {
    glyph: 'double-check',
    tone: 'gray',
    label: 'Read',
  });
});
```

Add this test before `messageDeliveryVisual keeps transient and failure states distinct`:

```ts
test('messageDeliveryVisual marks sending clock as animated', () => {
  assert.deepEqual(messageDeliveryVisual('sending'), {
    glyph: 'clock',
    tone: 'gray',
    label: 'Sending',
    motion: 'pulse',
  });
});
```

Update the transient-state test so it no longer only checks the clock glyph:

```ts
test('messageDeliveryVisual keeps transient and failure states distinct', () => {
  assert.equal(messageDeliveryVisual('pending_send')?.motion, 'pulse');
  assert.equal(messageDeliveryVisual('processing')?.glyph, 'spinner');
  assert.deepEqual(messageDeliveryVisual('processing_failed'), {
    glyph: 'exclamation',
    tone: 'red',
    label: 'Sending failed',
  });
  assert.deepEqual(messageDeliveryVisual('failed'), {
    glyph: 'exclamation',
    tone: 'red',
    label: 'Sending failed',
  });
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
pnpm --dir app/desktop exec tsx --test app/desktop/tests/deliveryStatus.test.tsx
```

Expected: FAIL because `delivered` still returns `double-check`, `read` still returns `blue`, and `motion` is not present.

- [ ] **Step 3: Implement the minimal status mapping change**

Replace `app/desktop/src/features/chat/deliveryStatus.ts` with:

```ts
export type MessageDeliveryVisual = {
  glyph: 'single-check' | 'double-check' | 'clock' | 'spinner' | 'exclamation';
  tone: 'gray' | 'blue' | 'red';
  label: string;
  motion?: 'pulse';
};

export function messageDeliveryVisual(status?: string | null): MessageDeliveryVisual | null {
  const normalized = status?.trim().toLowerCase();
  if (!normalized) return null;

  if (normalized === 'read' || normalized === 'responded') {
    return { glyph: 'double-check', tone: 'gray', label: 'Read' };
  }
  if (normalized === 'delivered') {
    return { glyph: 'single-check', tone: 'gray', label: 'Delivered' };
  }
  if (normalized === 'sent') {
    return { glyph: 'single-check', tone: 'gray', label: 'Sent' };
  }
  if (normalized === 'sending' || normalized === 'pending_send') {
    return { glyph: 'clock', tone: 'gray', label: 'Sending', motion: 'pulse' };
  }
  if (normalized === 'processing' || normalized === 'awaiting reply' || normalized === 'handed_off_direct' || normalized === 'handed_off_mailbox') {
    return { glyph: 'spinner', tone: 'gray', label: 'Processing' };
  }
  if (normalized === 'failed' || normalized === 'processing_failed') {
    return { glyph: 'exclamation', tone: 'red', label: 'Sending failed' };
  }
  return null;
}
```

- [ ] **Step 4: Run the focused test and verify it passes**

Run:

```bash
pnpm --dir app/desktop exec tsx --test app/desktop/tests/deliveryStatus.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/desktop/src/features/chat/deliveryStatus.ts app/desktop/tests/deliveryStatus.test.tsx
git commit -m "fix: align message delivery status glyphs"
```

---

### Task 2: Animate the sending clock without destabilizing the footer slot

**Files:**
- Modify: `app/desktop/src/kordi-app/components/transcript.tsx`
- Modify: `app/desktop/tests/transcriptDensity.test.tsx`

- [ ] **Step 1: Write failing transcript-render tests**

Add this test after `sent-message delivery glyph keeps one stable slot so status changes do not refresh the whole popover` in `app/desktop/tests/transcriptDensity.test.tsx`:

```ts
test('sending own message renders an animated clock in the stable delivery slot', () => {
  const message: Message = {
    role: 'user',
    sender: 'Me',
    senderType: 'human',
    isOwnMessage: true,
    text: 'hello',
    time: '00:45',
    statusChips: ['sending'],
  };

  const markup = renderToStaticMarkup(createElement(MessageBubble, { msg: message }));

  assert.match(markup, /app-message-delivery-footer ml-3/);
  assert.match(markup, /data-message-delivery-status="sending"/);
  assert.match(markup, /data-message-delivery-glyph="clock"/);
  assert.match(markup, /aria-label="Sending"/);
  assert.match(markup, /app-message-delivery-clock-active/);
  assert.doesNotMatch(markup, /lucide-loader-circle[^>]*animate-spin/);
});
```

Update the existing sent-message delivery test assertion that currently expects only slate opacity classes by adding:

```ts
assert.doesNotMatch(markup, /app-message-delivery-clock-active/);
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
pnpm --dir app/desktop exec tsx --test app/desktop/tests/transcriptDensity.test.tsx
```

Expected: FAIL because the clock does not receive `app-message-delivery-clock-active` yet.

- [ ] **Step 3: Implement the minimal rendering change**

In `app/desktop/src/kordi-app/components/transcript.tsx`, replace the clock/spinner glyph lines inside `MessageDeliveryGlyph` with:

```tsx
      <Clock3
        className={cn(
          glyphClass('clock'),
          visual?.glyph === 'clock' && visual.motion === 'pulse' && 'app-message-delivery-clock-active animate-pulse',
        )}
        aria-hidden="true"
      />
      <LoaderCircle className={cn(glyphClass('spinner'), activeGlyph === 'spinner' && 'animate-spin')} aria-hidden="true" />
```

Do not change the surrounding stable glyph stack or the footer widths.

- [ ] **Step 4: Run focused tests and verify they pass**

Run:

```bash
pnpm --dir app/desktop exec tsx --test app/desktop/tests/transcriptDensity.test.tsx app/desktop/tests/deliveryStatus.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/desktop/src/kordi-app/components/transcript.tsx app/desktop/tests/transcriptDensity.test.tsx
git commit -m "feat: animate outgoing sending clock"
```

---

### Task 3: Add UI message read-receipt summary type and mapper

**Files:**
- Modify: `app/desktop/src/kordi-app/types/message.ts`
- Modify: `app/desktop/src/kordi-app/types.ts`
- Modify: `app/desktop/src/features/canonical/readModel/messageMapping.ts`
- Modify: `app/desktop/tests/canonicalBridgeVisibilityReadModel.test.tsx`

- [ ] **Step 1: Write the failing read-model test**

Add this test to `app/desktop/tests/canonicalBridgeVisibilityReadModel.test.tsx` after the first canonical read-model message test:

```ts
test('canonical read model maps positive read receipt summaries onto own messages', () => {
  const sessionId = 'session:group:read-receipts';
  const canonicalState = {
    storagePath: '/tmp/canonical.sqlite3',
    profile: {
      id: 'profile:me',
      displayName: 'Me',
      humanIdentityId: 'human:acct_me',
      activeAgentIdentityId: 'agent:local',
      storageRoot: '/tmp',
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    identities: [
      { id: 'human:acct_me', kind: 'human', displayName: 'Me', source: 'local', avatarKey: 'me', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'human:acct_a', kind: 'human', displayName: 'Alice', source: 'bridge', sourceHostId: 'cloud', bridgeNodeId: 'acct_a', humanId: 'acct_a', avatarKey: 'cloud:acct_a', profileImageUrl: null, createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:local', kind: 'agent', displayName: 'My Kordi', source: 'local', ownerIdentityId: 'human:acct_me', avatarKey: 'agent-local', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: sessionId, kind: 'group', title: 'Launch group', status: 'active', createdByIdentityId: 'human:acct_me', primaryIdentityId: null, relationshipIdentityId: null, metadata: { groupSpaceId: 'group:launch' }, createdAtMs: 1, updatedAtMs: 2, lastMessageAtMs: 2 },
    ],
    participants: [
      { sessionId, identityId: 'human:acct_me', role: 'self', createdAtMs: 1 },
      { sessionId, identityId: 'human:acct_a', role: 'person', createdAtMs: 1 },
    ],
    messages: [
      {
        id: 'msg:outbound',
        sessionId,
        senderIdentityId: 'human:acct_me',
        senderRole: 'user',
        messageKind: 'message',
        contentText: 'hello group',
        content: {
          sender: 'Me',
          timeLabel: '00:45',
          deliveryState: 'read',
          readReceiptSummary: {
            count: 1,
            participants: [{ accountId: 'acct_a', identityId: 'human:acct_a', readAt: '2026-06-06T12:00:02Z' }],
          },
        },
        status: 'sent',
        sequenceNum: 1,
        createdAtMs: 2,
        updatedAtMs: 2,
        contentHash: null,
        sourceTransport: 'cloud-group',
        sourceEventId: 'event:outbound',
      },
    ],
    delegatedExchanges: [],
    contextSnapshots: [],
  };

  const readModel = createCanonicalSessionReadModel(canonicalState as never);
  const messages = readModel?.messages(sessionId) ?? [];

  assert.equal(messages[0]?.readReceiptSummary?.count, 1);
  assert.equal(messages[0]?.readReceiptSummary?.participants[0]?.id, 'human:acct_a');
  assert.equal(messages[0]?.readReceiptSummary?.participants[0]?.name, 'Alice');
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
pnpm --dir app/desktop exec tsx --test app/desktop/tests/canonicalBridgeVisibilityReadModel.test.tsx
```

Expected: FAIL with `readReceiptSummary` missing or `undefined`.

- [ ] **Step 3: Add the UI types**

In `app/desktop/src/kordi-app/types/message.ts`, add after `MessageReplySummary`:

```ts
export type MessageReadReceiptParticipant = {
  id: string;
  name: string;
  avatarSeed?: string | null;
  profileImageUrl?: string | null;
  readAt?: string | null;
};

export type MessageReadReceiptSummary = {
  count: number;
  participants: MessageReadReceiptParticipant[];
};
```

Then add this optional field to `export type Message` after `replySummary?: MessageReplySummary;`:

```ts
  readReceiptSummary?: MessageReadReceiptSummary | null;
```

In `app/desktop/src/kordi-app/types.ts`, add `MessageReadReceiptParticipant` and `MessageReadReceiptSummary` to the import/export list from `./types/message`:

```ts
  MessageReadReceiptParticipant,
  MessageReadReceiptSummary,
```

and:

```ts
  MessageReadReceiptParticipant,
  MessageReadReceiptSummary,
```

- [ ] **Step 4: Add canonical content parsing helpers**

In `app/desktop/src/features/canonical/readModel/messageMapping.ts`, add these helpers near the existing `contentRecord`/`stringValue` helpers:

```ts
function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function canonicalReadReceiptSummary(
  content: Record<string, unknown>,
  identityById: Map<string, CanonicalIdentity>,
): Message['readReceiptSummary'] {
  const summary = contentRecord(content.readReceiptSummary);
  const rawParticipants = Array.isArray(summary.participants) ? summary.participants : [];
  const participants = rawParticipants.flatMap((value) => {
    const record = contentRecord(value);
    const accountId = stringValue(record.accountId)?.trim() ?? '';
    const identityId = stringValue(record.identityId)?.trim() || (accountId ? `human:${accountId}` : '');
    if (!identityId) return [];
    const identity = identityById.get(identityId);
    const name = identity?.displayName || stringValue(record.name)?.trim() || accountId || 'Someone';
    return [{
      id: identity?.id ?? identityId,
      name,
      avatarSeed: identity?.avatarKey ?? stringValue(record.avatarSeed) ?? null,
      profileImageUrl: identity?.profileImageUrl ?? stringValue(record.profileImageUrl) ?? null,
      readAt: stringValue(record.readAt) ?? null,
    }];
  });
  const count = Math.max(0, Math.floor(numberValue(summary.count) ?? participants.length));
  if (count <= 0) return null;
  return { count, participants: participants.slice(0, Math.max(count, participants.length)) };
}
```

- [ ] **Step 5: Map the summary onto UI messages**

In the return object of `mapCanonicalMessage`, add this property after `replySummary`/before `sourceMessage` fields if present, otherwise after `replyAliasIds`:

```ts
    readReceiptSummary: isOwnMessage && role === 'user' ? canonicalReadReceiptSummary(content, identityById) : null,
```

In `messageSnapshotKey` in `app/desktop/src/kordi-app/components/transcript.tsx`, add this element after the `replySummary` key segment:

```ts
    msg.readReceiptSummary ? [msg.readReceiptSummary.count, msg.readReceiptSummary.participants.map((participant) => [participant.id, participant.name, participant.readAt ?? ''].join(':')).join('|')].join(':') : '',
```

This keeps memoized message bubbles updating when read receipts change.

- [ ] **Step 6: Run the focused test and verify it passes**

Run:

```bash
pnpm --dir app/desktop exec tsx --test app/desktop/tests/canonicalBridgeVisibilityReadModel.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add app/desktop/src/kordi-app/types/message.ts app/desktop/src/kordi-app/types.ts app/desktop/src/features/canonical/readModel/messageMapping.ts app/desktop/src/kordi-app/components/transcript.tsx app/desktop/tests/canonicalBridgeVisibilityReadModel.test.tsx
git commit -m "feat: map message read receipt summaries"
```

---

### Task 4: Derive group read receipts from Cloud outgoing message copies

**Files:**
- Modify: `app/desktop/src/features/cloud/cloudGroupMessages.ts`
- Modify: `app/desktop/src/features/cloud/useCloudBridgeState.ts`
- Modify: `app/desktop/tests/cloudGroupMessages.test.tsx`
- Modify: `app/desktop/tests/cloudBridgeState.test.tsx`

- [ ] **Step 1: Add failing Cloud helper tests**

In `app/desktop/tests/cloudGroupMessages.test.tsx`, import the new helper next to `cloudGroupDeliveryStateFromMessages`:

```ts
  cloudGroupReadReceiptSummaryFromMessages,
```

Add this test near the existing delivery-state tests:

```ts
test('cloudGroupReadReceiptSummaryFromMessages returns only recipients who read the outbound group message', () => {
  const body = encodeCloudGroupControl({
    kind: 'group-message',
    groupId: 'session:group:test',
    createdByAccountId: 'acct_me',
    message: {
      id: 'msg_1',
      text: 'hello',
      senderAccountId: 'acct_me',
      senderDisplayName: 'Me',
      createdAt: '2026-06-06T12:00:00Z',
    },
  });

  const summary = cloudGroupReadReceiptSummaryFromMessages({
    accountId: 'acct_me',
    messageId: 'msg_1',
    messages: [
      {
        messageId: 'copy_1',
        fromAccountId: 'acct_me',
        toAccountId: 'acct_a',
        body,
        createdAt: '2026-06-06T12:00:00Z',
        deliveredAt: '2026-06-06T12:00:01Z',
        readAt: '2026-06-06T12:00:02Z',
        direction: 'outgoing',
      },
      {
        messageId: 'copy_2',
        fromAccountId: 'acct_me',
        toAccountId: 'acct_b',
        body,
        createdAt: '2026-06-06T12:00:00Z',
        deliveredAt: '2026-06-06T12:00:01Z',
        readAt: null,
        direction: 'outgoing',
      },
    ],
  });

  assert.deepEqual(summary, {
    count: 1,
    participants: [{ accountId: 'acct_a', identityId: 'human:acct_a', readAt: '2026-06-06T12:00:02Z' }],
  });
});

test('cloudGroupReadReceiptSummaryFromMessages returns null when no recipients have read', () => {
  const body = encodeCloudGroupControl({
    kind: 'group-message',
    groupId: 'session:group:test',
    createdByAccountId: 'acct_me',
    message: {
      id: 'msg_1',
      text: 'hello',
      senderAccountId: 'acct_me',
      senderDisplayName: 'Me',
      createdAt: '2026-06-06T12:00:00Z',
    },
  });

  const summary = cloudGroupReadReceiptSummaryFromMessages({
    accountId: 'acct_me',
    messageId: 'msg_1',
    messages: [{
      messageId: 'copy_1',
      fromAccountId: 'acct_me',
      toAccountId: 'acct_a',
      body,
      createdAt: '2026-06-06T12:00:00Z',
      deliveredAt: '2026-06-06T12:00:01Z',
      readAt: null,
      direction: 'outgoing',
    }],
  });

  assert.equal(summary, null);
});
```

- [ ] **Step 2: Run helper tests and verify they fail**

Run:

```bash
pnpm --dir app/desktop exec tsx --test app/desktop/tests/cloudGroupMessages.test.tsx
```

Expected: FAIL because `cloudGroupReadReceiptSummaryFromMessages` is not exported.

- [ ] **Step 3: Implement the Cloud helper**

In `app/desktop/src/features/cloud/cloudGroupMessages.ts`, add after `cloudGroupDeliveryStateFromMessages`:

```ts
export type CloudGroupReadReceiptSummary = {
  count: number;
  participants: Array<{
    accountId: string;
    identityId: string;
    readAt: string;
  }>;
};

export function cloudGroupReadReceiptSummaryFromMessages(input: {
  accountId: string;
  messageId: string;
  messages: CloudMessage[];
}): CloudGroupReadReceiptSummary | null {
  const accountId = cleanText(input.accountId);
  const messageId = cleanText(input.messageId);
  if (!accountId || !messageId) return null;

  const participantsByAccountId = new Map<string, { accountId: string; identityId: string; readAt: string }>();
  for (const message of input.messages) {
    if (message.fromAccountId !== accountId || message.direction !== 'outgoing' || !message.readAt) continue;
    const envelope = parseCloudGroupControl(message.body);
    if (envelope?.kind !== 'group-message' || envelope.message?.id !== messageId) continue;
    const recipientAccountId = cleanText(message.toAccountId);
    const readAt = cleanText(message.readAt);
    if (!recipientAccountId || !readAt) continue;
    participantsByAccountId.set(recipientAccountId, {
      accountId: recipientAccountId,
      identityId: `human:${recipientAccountId}`,
      readAt,
    });
  }

  const participants = [...participantsByAccountId.values()]
    .sort((left, right) => left.accountId.localeCompare(right.accountId));
  return participants.length > 0 ? { count: participants.length, participants } : null;
}
```

- [ ] **Step 4: Write Cloud group summaries into canonical message content**

In `app/desktop/src/features/cloud/useCloudBridgeState.ts`, add the import beside `cloudGroupDeliveryStateFromMessages`:

```ts
  cloudGroupReadReceiptSummaryFromMessages,
```

In the effect that currently calls `cloudGroupDeliveryStateFromMessages`, replace the body of the `current.messages.map` callback with this version:

```ts
        if (message.senderRole !== 'user') return message;
        const deliveryState = cloudGroupDeliveryStateFromMessages({
          accountId: account.accountId,
          messageId: message.id,
          messages: cloudMessages,
        });
        const readReceiptSummary = cloudGroupReadReceiptSummaryFromMessages({
          accountId: account.accountId,
          messageId: message.id,
          messages: cloudMessages,
        });
        if (!deliveryState && !readReceiptSummary) return message;
        const content = objectContent(message.content);
        const existingReadReceiptSummary = objectContent(content.readReceiptSummary);
        const existingReadCount = typeof existingReadReceiptSummary.count === 'number' && Number.isFinite(existingReadReceiptSummary.count)
          ? Math.max(0, Math.floor(existingReadReceiptSummary.count))
          : 0;
        const nextReadCount = readReceiptSummary?.count ?? 0;
        if (message.status === 'sent' && content.deliveryState === deliveryState && existingReadCount === nextReadCount) return message;
        changed = true;
        return {
          ...message,
          status: deliveryState ? 'sent' : message.status,
          content: {
            ...content,
            ...(deliveryState ? { deliveryState } : {}),
            ...(readReceiptSummary ? { readReceiptSummary } : { readReceiptSummary: null }),
          },
        };
```

- [ ] **Step 5: Run focused tests and verify they pass**

Run:

```bash
pnpm --dir app/desktop exec tsx --test app/desktop/tests/cloudGroupMessages.test.tsx app/desktop/tests/cloudBridgeState.test.tsx
```

Expected: PASS for the new helper tests and the read-model assertion from Task 3.

- [ ] **Step 6: Commit**

```bash
git add app/desktop/src/features/cloud/cloudGroupMessages.ts app/desktop/src/features/cloud/useCloudBridgeState.ts app/desktop/tests/cloudGroupMessages.test.tsx app/desktop/tests/cloudBridgeState.test.tsx
git commit -m "feat: derive cloud group read receipts"
```

---

### Task 5: Render group read footer only when read count is positive

**Files:**
- Modify: `app/desktop/src/kordi-app/components/transcript.tsx`
- Modify: `app/desktop/tests/transcriptDensity.test.tsx`

- [ ] **Step 1: Add failing render tests**

Add these tests to `app/desktop/tests/transcriptDensity.test.tsx` after the outgoing delivery-status tests:

```ts
test('own group message renders compact read footer when at least one participant has read', () => {
  const message: Message = {
    role: 'user',
    sender: 'Me',
    senderType: 'human',
    isOwnMessage: true,
    text: 'hello group',
    time: '00:45',
    statusChips: ['read'],
    readReceiptSummary: {
      count: 2,
      participants: [
        { id: 'human:acct_a', name: 'Alice', avatarSeed: 'cloud:acct_a', profileImageUrl: null, readAt: '2026-06-06T12:00:02Z' },
        { id: 'human:acct_b', name: 'Bob', avatarSeed: 'cloud:acct_b', profileImageUrl: null, readAt: '2026-06-06T12:00:03Z' },
      ],
    },
  };

  const markup = renderToStaticMarkup(createElement(MessageBubble, { msg: message }));

  assert.match(markup, /app-message-read-receipts/);
  assert.match(markup, /Read by 2/);
  assert.match(markup, /Alice/);
  assert.match(markup, /Bob/);
  assert.match(markup, /data-message-delivery-glyph="double-check"/);
});

test('own group message suppresses read footer when read count is zero', () => {
  const message: Message = {
    role: 'user',
    sender: 'Me',
    senderType: 'human',
    isOwnMessage: true,
    text: 'hello group',
    time: '00:45',
    statusChips: ['delivered'],
    readReceiptSummary: {
      count: 0,
      participants: [],
    },
  };

  const markup = renderToStaticMarkup(createElement(MessageBubble, { msg: message }));

  assert.doesNotMatch(markup, /app-message-read-receipts/);
  assert.doesNotMatch(markup, /Read by 0/);
  assert.match(markup, /data-message-delivery-glyph="single-check"/);
});
```

- [ ] **Step 2: Run transcript test and verify it fails**

Run:

```bash
pnpm --dir app/desktop exec tsx --test app/desktop/tests/transcriptDensity.test.tsx
```

Expected: FAIL because no read-receipt footer is rendered.

- [ ] **Step 3: Add the read-receipt footer component**

In `app/desktop/src/kordi-app/components/transcript.tsx`, add after `MessageFooter`:

```tsx
function MessageReadReceiptFooter({ summary, own }: { summary?: Message['readReceiptSummary'] | null; own: boolean }) {
  const count = Math.max(0, Math.floor(summary?.count ?? 0));
  if (!own || count <= 0) return null;
  const participants = (summary?.participants ?? []).slice(0, 3);
  const names = participants.map((participant) => participant.name).filter(Boolean);
  const title = names.length > 0 ? `Read by ${names.join(', ')}` : `Read by ${count}`;

  return (
    <div className="app-message-read-receipts mt-1 flex items-center justify-end gap-1.5 text-[10px] leading-none text-slate-500/80" title={title}>
      {participants.length > 0 ? (
        <span className="inline-flex -space-x-1" aria-hidden="true">
          {participants.map((participant) => (
            <IdentityAvatar
              key={participant.id}
              kind="human"
              seed={participant.avatarSeed ?? participant.id}
              name={participant.name}
              imageUrl={participant.profileImageUrl}
              className="h-4 w-4 border border-[color:var(--app-panel-bg)]"
            />
          ))}
        </span>
      ) : null}
      <span>Read by {count}</span>
    </div>
  );
}
```

- [ ] **Step 4: Render it below own human message bubbles**

In `MessageBubbleView`, after the `RequestReplyLine` block, add:

```tsx
      <MessageReadReceiptFooter summary={msg.readReceiptSummary} own={isOwnHumanMessage} />
```

The bottom of the human message return should end like:

```tsx
      {showCompactFooter ? (
        <RequestReplyLine
          summary={msg.replySummary}
          own={isOwnHumanMessage}
          onNavigateToMessage={onNavigateToMessage}
        />
      ) : null}
      <MessageReadReceiptFooter summary={msg.readReceiptSummary} own={isOwnHumanMessage} />
    </div>
```

- [ ] **Step 5: Run transcript tests and verify they pass**

Run:

```bash
pnpm --dir app/desktop exec tsx --test app/desktop/tests/transcriptDensity.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/desktop/src/kordi-app/components/transcript.tsx app/desktop/tests/transcriptDensity.test.tsx
git commit -m "feat: show compact group read receipts"
```

---

### Task 6: Preserve agent-session completion semantics

**Files:**
- Modify: `app/desktop/tests/deliveryStatus.test.tsx`
- Modify: `app/desktop/tests/transcriptDensity.test.tsx`
- Modify: `app/desktop/src/features/canonical/readModel/messageMapping.ts`

- [ ] **Step 1: Add agent semantics tests**

Add this to `app/desktop/tests/deliveryStatus.test.tsx`:

```ts
test('agent-session status semantics use sent for queued work and responded for finished work', () => {
  assert.deepEqual(messageDeliveryVisual('sent'), {
    glyph: 'single-check',
    tone: 'gray',
    label: 'Sent',
  });
  assert.deepEqual(messageDeliveryVisual('responded'), {
    glyph: 'double-check',
    tone: 'gray',
    label: 'Read',
  });
});
```

Add this to `app/desktop/tests/transcriptDensity.test.tsx`:

```ts
test('own agent-session request uses double check only after response is marked responded', () => {
  const sentMessage: Message = {
    role: 'user',
    sender: 'Me',
    senderType: 'human',
    isOwnMessage: true,
    text: '@My Kordi summarize this',
    time: '00:45',
    statusChips: ['sent'],
  };
  const respondedMessage: Message = {
    ...sentMessage,
    statusChips: ['responded'],
  };

  const sentMarkup = renderToStaticMarkup(createElement(MessageBubble, { msg: sentMessage }));
  const respondedMarkup = renderToStaticMarkup(createElement(MessageBubble, { msg: respondedMessage }));

  assert.match(sentMarkup, /data-message-delivery-glyph="single-check"/);
  assert.match(respondedMarkup, /data-message-delivery-glyph="double-check"/);
});
```

Also import `canonicalUserStatusChip` in `app/desktop/tests/deliveryStatus.test.tsx`:

```ts
import { canonicalUserStatusChip } from '../src/features/canonical/readModel/messageMapping';
```

Add this test to `app/desktop/tests/deliveryStatus.test.tsx`:

```ts
test('canonical in-progress agent handoff user chips stay single-check sent', () => {
  const message = { status: 'sent' } as Parameters<typeof canonicalUserStatusChip>[0];

  assert.equal(canonicalUserStatusChip(message, { deliveryState: 'processing' }), 'sent');
  assert.equal(canonicalUserStatusChip(message, { deliveryState: 'handed_off_direct' }), 'sent');
  assert.equal(canonicalUserStatusChip(message, { deliveryState: 'handed_off_mailbox' }), 'sent');
  assert.equal(canonicalUserStatusChip(message, { deliveryState: 'responded' }), 'responded');
});
```

- [ ] **Step 2: Run focused tests and verify the canonical chip test fails**

Run:

```bash
pnpm --dir app/desktop exec tsx --test app/desktop/tests/deliveryStatus.test.tsx app/desktop/tests/transcriptDensity.test.tsx
```

Expected: FAIL because `canonicalUserStatusChip` still maps processing handoff states to `read`.

- [ ] **Step 3: Stop mapping processing handoff states to read for user chips**

Update `canonicalUserStatusChip` in `app/desktop/src/features/canonical/readModel/messageMapping.ts` so processing handoff states map to `sent`, while terminal `responded` remains double-check:

```ts
export function canonicalUserStatusChip(message: CanonicalSessionMessage, content: Record<string, unknown>) {
  const deliveryState = stringValue(content.deliveryState)?.trim().toLowerCase();
  if (deliveryState) {
    if (deliveryState === 'processing' || deliveryState === 'handed_off_direct' || deliveryState === 'handed_off_mailbox') {
      return 'sent';
    }
    if (deliveryState === 'processing_failed') return 'failed';
    return deliveryState;
  }

  return message.status !== 'sent' ? message.status : undefined;
}
```

- [ ] **Step 4: Run focused tests again**

Run:

```bash
pnpm --dir app/desktop exec tsx --test app/desktop/tests/deliveryStatus.test.tsx app/desktop/tests/transcriptDensity.test.tsx app/desktop/tests/canonicalBridgeVisibilityReadModel.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/desktop/src/features/canonical/readModel/messageMapping.ts app/desktop/tests/deliveryStatus.test.tsx app/desktop/tests/transcriptDensity.test.tsx
git commit -m "fix: align agent request status semantics"
```

---

### Task 7: Final verification and cleanup

**Files:**
- No source edits unless verification finds a defect.

- [ ] **Step 1: Run all targeted status/read tests**

Run:

```bash
pnpm --dir app/desktop exec tsx --test \
  app/desktop/tests/deliveryStatus.test.tsx \
  app/desktop/tests/transcriptDensity.test.tsx \
  app/desktop/tests/cloudGroupMessages.test.tsx \
  app/desktop/tests/cloudBridgeState.test.tsx \
  app/desktop/tests/chatDetailPanel.test.tsx
```

Expected: PASS.

- [ ] **Step 2: Run baseline tests from planning pass**

Run:

```bash
pnpm --dir app/desktop exec tsx --test \
  app/desktop/tests/messageBubbleShape.test.tsx \
  app/desktop/tests/chatDetailPanel.test.tsx \
  app/desktop/tests/cloudGroupMessages.test.tsx \
  app/desktop/tests/cloudBridgeState.test.tsx
```

Expected: PASS.

- [ ] **Step 3: Run typecheck**

Run:

```bash
pnpm --dir app/desktop typecheck
```

Expected: PASS.

- [ ] **Step 4: Check formatting-sensitive diff issues**

Run:

```bash
git diff --check
```

Expected: no output.

- [ ] **Step 5: Review diff for scope and secrets**

Run:

```bash
git diff --stat origin/main...HEAD
git diff origin/main...HEAD -- app/desktop/src app/desktop/tests | rg -n "coordinar|token|secret|password|PRIVATE|BEGIN|127\.0\.0\.1|localhost" || true
```

Expected: diff stat includes only status/read-receipt files; secret/private-host scan has no relevant hits. `127.0.0.1` or `localhost` should not be newly introduced by this work.

- [ ] **Step 6: Confirm there are no uncommitted cleanup changes**

Run:

```bash
git status --short
```

Expected: no output. If this command prints files, inspect them with `git diff` and either commit an intentional fix with a specific message or revert accidental changes before handoff.

---

## Self-Review Notes

- Spec coverage:
  - Animated sending clock: Task 1 + Task 2.
  - Gray single check for sent/delivered: Task 1.
  - Double check for read/agent-complete: Task 1 + Task 6.
  - Group read footer only when read count > 0: Task 3 + Task 4 + Task 5.
  - Direct/group/agent tests: Tasks 1, 4, 5, 6, 7.
- Scope control:
  - No Cloud server migration is planned; existing outgoing per-recipient Cloud message copies already contain `readAt`.
  - No docs changes are planned; this is user-facing UI behavior and tests.
  - No public host/dev URL is introduced.
- Risk notes:
  - `cloudGroupDeliveryStateFromMessages` currently treats all outgoing copies read as `read`; the new footer uses a more granular count of read copies.
  - If a group has three recipients and one reads, footer shows `Read by 1` while the main glyph may remain single-check until all copies are read. This matches the rule that the group footer appears only when read count > 0 and avoids overstating all-read status.
  - This plan keeps the main group-message glyph conservative: double-check only when every outgoing recipient copy is read; the separate footer communicates partial group reads.
