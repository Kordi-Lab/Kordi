# Participant Spaces Read Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a tested participant-space read model for Chats so the sidebar can later show people/agent/group spaces before sessions.

**Architecture:** Keep existing `chatConversations` unchanged for transcript routing. Add a parallel derived `participantSpaces` read model that groups current `Conversation` rows by canonical participants, aggregates unread/status/preview metadata, and exposes child session rows. This PR deliberately avoids backend persistence and visual sidebar replacement.

**Tech Stack:** React 19, TypeScript, Node `tsx --test`, existing Kordi desktop view-model utilities.

---

## Scope

This plan implements PR 1 from #171 only:

- Create `ParticipantSpaceViewModel` types.
- Create pure grouping helpers.
- Expose `participantSpaces` from `useWorkspaceViewModels`.
- Add regression tests.

Out of scope:

- Sidebar drill-in UI.
- Durable `participant_spaces` tables.
- Group creation dialog.
- Invite lifecycle commands.
- Group fan-out messaging.

## File map

- Create: `app/desktop/src/features/chat/participantSpaces.ts`
  - Owns `ParticipantSpaceViewModel` and grouping helpers.
  - Pure functions only; no React hooks.
- Modify: `app/desktop/src/kordi-app/types.ts`
  - Exports participant-space types for shell/sidebar use.
- Modify: `app/desktop/src/app/useWorkspaceViewModels.ts`
  - Calls `buildParticipantSpaces(chatConversations)` and returns `participantSpaces`.
- Test: `app/desktop/tests/participantSpaces.test.tsx`
  - Covers direct-human grouping, direct-agent grouping, local-agent grouping, unread aggregation, ordering, search helper behavior.
- Optional later UI PR will modify `WorkspaceSidebar.tsx`; this PR does not.

---

### Task 1: Add failing participant-space grouping tests

**Files:**
- Create: `app/desktop/tests/participantSpaces.test.tsx`

- [ ] **Step 1: Write the failing test file**

Create `app/desktop/tests/participantSpaces.test.tsx` with tests that import functions that do not exist yet:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildParticipantSpaces,
  filterParticipantSpaces,
} from '../src/features/chat/participantSpaces';
import type { Conversation } from '../src/kordi-app/types';

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'session:default',
    canonicalSessionId: 'session:default',
    name: 'Session',
    type: 'person',
    subtitle: 'Preview',
    unread: 0,
    bridges: ['Bridge'],
    trust: 'Bridge',
    directness: 'Direct chat',
    participants: ['Me', 'Bob'],
    canonicalParticipants: [
      { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
      { id: 'human:bob', name: 'Bob', kind: 'human', role: 'delegate', source: 'bridge', avatarKey: 'bob' },
    ],
    messages: [{ role: 'person', sender: 'Bob', text: 'Preview', time: '10:00' }],
    updatedAtLabel: '10:00',
    ...overrides,
  };
}

test('buildParticipantSpaces groups direct human sessions by participant identity', () => {
  const spaces = buildParticipantSpaces([
    conversation({
      id: 'session:bob:old',
      canonicalSessionId: 'session:bob:old',
      name: 'Old Bob thread',
      subtitle: 'old preview',
      unread: 1,
      updatedAtLabel: '09:00',
      messages: [{ role: 'person', sender: 'Bob', text: 'old preview', time: '09:00' }],
    }),
    conversation({
      id: 'session:bob:new',
      canonicalSessionId: 'session:bob:new',
      name: 'New Bob thread',
      subtitle: 'new preview',
      unread: 2,
      updatedAtLabel: '10:00',
      messages: [{ role: 'person', sender: 'Bob', text: 'new preview', time: '10:00' }],
    }),
  ]);

  assert.equal(spaces.length, 1);
  assert.equal(spaces[0]?.id, 'direct-human:human:bob');
  assert.equal(spaces[0]?.kind, 'direct-human');
  assert.equal(spaces[0]?.title, 'Bob');
  assert.equal(spaces[0]?.sessionCount, 2);
  assert.equal(spaces[0]?.unread, 3);
  assert.equal(spaces[0]?.preview, 'new preview');
  assert.deepEqual(spaces[0]?.sessions.map((session) => session.id), ['session:bob:new', 'session:bob:old']);
});

test('buildParticipantSpaces separates direct human and direct agent spaces on same Bridge node', () => {
  const spaces = buildParticipantSpaces([
    conversation({
      id: 'session:bob-person',
      type: 'person',
      name: 'Bob',
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'human:bob', name: 'Bob', kind: 'human', role: 'delegate', source: 'bridge', bridgeNodeId: 'node-bob', avatarKey: 'bob' },
      ],
    }),
    conversation({
      id: 'session:bob-agent',
      type: 'external-agent',
      name: "Bob's Kordi",
      participants: ['Me', "Bob's Kordi"],
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'agent:bob-kordi', name: "Bob's Kordi", kind: 'agent', role: 'delegate', source: 'bridge', bridgeNodeId: 'node-bob', ownerName: 'Bob', avatarKey: 'agent-bob' },
      ],
    }),
  ]);

  assert.deepEqual(spaces.map((space) => [space.id, space.kind, space.title]), [
    ['direct-human:human:bob', 'direct-human', 'Bob'],
    ['direct-agent:agent:bob-kordi', 'direct-agent', "Bob's Kordi"],
  ]);
});

test('buildParticipantSpaces builds a group space when a conversation has multiple non-self participants', () => {
  const spaces = buildParticipantSpaces([
    conversation({
      id: 'session:design-group',
      canonicalSessionId: 'session:design-group',
      type: 'relationship',
      name: 'Kordi design group',
      subtitle: 'Planning sidebar IA',
      participants: ['Me', 'Bob', "Bob's Kordi"],
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'human:bob', name: 'Bob', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'bob' },
        { id: 'agent:bob-kordi', name: "Bob's Kordi", kind: 'agent', role: 'delegate', source: 'bridge', ownerName: 'Bob', avatarKey: 'agent-bob' },
      ],
    }),
  ]);

  assert.equal(spaces.length, 1);
  assert.equal(spaces[0]?.kind, 'group');
  assert.equal(spaces[0]?.title, 'Kordi design group');
  assert.equal(spaces[0]?.participantCount, 3);
  assert.deepEqual(spaces[0]?.avatarStack.map((avatar) => avatar.seed), ['me', 'bob', 'agent-bob']);
});

test('filterParticipantSpaces matches title, participant names, preview, and child session title', () => {
  const spaces = buildParticipantSpaces([
    conversation({
      id: 'session:bob',
      name: 'New Bob thread',
      subtitle: 'Budget question',
      messages: [{ role: 'person', sender: 'Bob', text: 'Budget question', time: '10:00' }],
    }),
  ]);

  assert.equal(filterParticipantSpaces(spaces, 'bob').length, 1);
  assert.equal(filterParticipantSpaces(spaces, 'budget').length, 1);
  assert.equal(filterParticipantSpaces(spaces, 'missing').length, 0);
});
```

- [ ] **Step 2: Run the tests to verify RED**

Run:

```bash
pnpm --dir app/desktop test:unit -- participantSpaces.test.tsx
```

Expected: FAIL because `../src/features/chat/participantSpaces` does not exist.

---

### Task 2: Add participant-space types

**Files:**
- Modify: `app/desktop/src/kordi-app/types.ts`

- [ ] **Step 1: Add exported types after `Conversation`**

Add these types below the existing `Conversation` type:

```ts
export type ParticipantSpaceKind = 'direct-human' | 'direct-agent' | 'group';

export type ParticipantSpaceAvatar = {
  kind: 'human' | 'agent';
  seed: string;
  imageUrl?: string | null;
};

export type ParticipantSpaceSessionViewModel = {
  id: string;
  canonicalSessionId?: string;
  title: string;
  preview: string;
  unread: number;
  updatedAtLabel?: string;
  updatedAtMs: number;
  participantCount: number;
  statusIndicator?: SessionStatusIndicator;
  conversation: Conversation;
};

export type ParticipantSpaceViewModel = {
  id: string;
  kind: ParticipantSpaceKind;
  title: string;
  participants: ConversationParticipant[];
  participantCount: number;
  sessionCount: number;
  unread: number;
  updatedAtLabel?: string;
  updatedAtMs: number;
  preview: string;
  avatarStack: ParticipantSpaceAvatar[];
  sessions: ParticipantSpaceSessionViewModel[];
};
```

- [ ] **Step 2: Run typecheck to verify types compile once implementation exists**

Do not run yet if Task 1 is still red due missing implementation.

---

### Task 3: Implement pure participant-space helpers

**Files:**
- Create: `app/desktop/src/features/chat/participantSpaces.ts`

- [ ] **Step 1: Create the helper module**

Create `participantSpaces.ts` with pure functions:

```ts
import type {
  Conversation,
  ConversationParticipant,
  ParticipantSpaceAvatar,
  ParticipantSpaceKind,
  ParticipantSpaceSessionViewModel,
  ParticipantSpaceViewModel,
} from '@/kordi-app/types';

function latestMessageText(conversation: Conversation) {
  return conversation.messages[conversation.messages.length - 1]?.text?.trim()
    || conversation.subtitle.trim()
    || conversation.name.trim();
}

function conversationTimestamp(conversation: Conversation, fallbackIndex: number) {
  const raw = (conversation as Conversation & { _updatedAtMs?: number })._updatedAtMs;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : fallbackIndex;
}

function isSelfParticipant(participant: ConversationParticipant) {
  return participant.role === 'self' || participant.source === 'local' && participant.kind === 'human';
}

function participantSortKey(participant: ConversationParticipant) {
  return [participant.kind, participant.id, participant.name].join('\u0000');
}

function nonSelfParticipants(conversation: Conversation) {
  const canonical = conversation.canonicalParticipants ?? [];
  if (canonical.length > 0) {
    return canonical.filter((participant) => !isSelfParticipant(participant));
  }
  return conversation.participants
    .filter((name) => !['me', 'you'].includes(name.trim().toLowerCase()))
    .map((name) => ({ id: `label:${name}`, name, kind: 'human', role: 'participant' })) satisfies ConversationParticipant[];
}

function allDisplayParticipants(conversation: Conversation) {
  const canonical = conversation.canonicalParticipants ?? [];
  if (canonical.length > 0) return canonical;
  return conversation.participants.map((name) => ({ id: `label:${name}`, name, kind: 'human', role: 'participant' })) satisfies ConversationParticipant[];
}

function spaceKindForConversation(conversation: Conversation, nonSelf: ConversationParticipant[]): ParticipantSpaceKind {
  const metadata = conversation as Conversation & { participantSpaceId?: string | null };
  if (metadata.participantSpaceId || conversation.type === 'relationship' || conversation.type === 'group' || nonSelf.length > 1) {
    return 'group';
  }
  const primary = nonSelf[0];
  if (primary?.kind === 'agent' || conversation.type === 'external-agent' || conversation.type === 'owned-agent') {
    return 'direct-agent';
  }
  return 'direct-human';
}

function directSpaceId(kind: ParticipantSpaceKind, primary: ConversationParticipant | undefined, conversation: Conversation) {
  if (kind === 'group') {
    const explicit = (conversation as Conversation & { participantSpaceId?: string | null }).participantSpaceId?.trim();
    if (explicit) return `group:${explicit}`;
    const participantKey = nonSelfParticipants(conversation)
      .map((participant) => participant.id)
      .sort()
      .join('+');
    return `group:${participantKey || conversation.canonicalSessionId || conversation.id}`;
  }
  return `${kind}:${primary?.id || conversation.canonicalSessionId || conversation.id}`;
}

function avatarForParticipant(participant: ConversationParticipant): ParticipantSpaceAvatar {
  return {
    kind: participant.kind === 'agent' ? 'agent' : 'human',
    seed: participant.avatarKey || participant.agentId || participant.humanId || participant.id || participant.name,
    imageUrl: participant.profileImageUrl ?? null,
  };
}

function buildSession(conversation: Conversation, updatedAtMs: number): ParticipantSpaceSessionViewModel {
  return {
    id: conversation.id,
    canonicalSessionId: conversation.canonicalSessionId,
    title: conversation.name,
    preview: latestMessageText(conversation),
    unread: Math.max(0, conversation.unread ?? 0),
    updatedAtLabel: conversation.updatedAtLabel,
    updatedAtMs,
    participantCount: Math.max(1, conversation.canonicalParticipantCount ?? allDisplayParticipants(conversation).length),
    statusIndicator: conversation.statusIndicator,
    conversation,
  };
}

export function buildParticipantSpaces(conversations: Conversation[]): ParticipantSpaceViewModel[] {
  const groups = new Map<string, {
    kind: ParticipantSpaceKind;
    participants: ConversationParticipant[];
    sessions: ParticipantSpaceSessionViewModel[];
  }>();

  conversations.forEach((conversation, index) => {
    const nonSelf = nonSelfParticipants(conversation).sort((left, right) => participantSortKey(left).localeCompare(participantSortKey(right)));
    const displayParticipants = allDisplayParticipants(conversation);
    const kind = spaceKindForConversation(conversation, nonSelf);
    const primary = nonSelf[0] ?? displayParticipants[0];
    const id = directSpaceId(kind, primary, conversation);
    const updatedAtMs = conversationTimestamp(conversation, conversations.length - index);
    const session = buildSession(conversation, updatedAtMs);
    const existing = groups.get(id);
    if (existing) {
      existing.sessions.push(session);
      for (const participant of displayParticipants) {
        if (!existing.participants.some((current) => current.id === participant.id)) {
          existing.participants.push(participant);
        }
      }
      return;
    }
    groups.set(id, { kind, participants: displayParticipants, sessions: [session] });
  });

  return [...groups.entries()]
    .map(([id, group]) => {
      const sessions = group.sessions.sort((left, right) => right.updatedAtMs - left.updatedAtMs);
      const latest = sessions[0];
      const nonSelf = group.participants.filter((participant) => !isSelfParticipant(participant));
      const title = group.kind === 'group'
        ? latest?.conversation.name || nonSelf.map((participant) => participant.name).join(', ') || 'Group'
        : nonSelf[0]?.name || latest?.conversation.name || 'Chat';
      return {
        id,
        kind: group.kind,
        title,
        participants: group.participants,
        participantCount: group.participants.length,
        sessionCount: sessions.length,
        unread: sessions.reduce((sum, session) => sum + session.unread, 0),
        updatedAtLabel: latest?.updatedAtLabel,
        updatedAtMs: latest?.updatedAtMs ?? 0,
        preview: latest?.preview ?? '',
        avatarStack: group.participants.slice(0, 4).map(avatarForParticipant),
        sessions,
      } satisfies ParticipantSpaceViewModel;
    })
    .sort((left, right) => right.updatedAtMs - left.updatedAtMs || left.title.localeCompare(right.title));
}

export function filterParticipantSpaces(spaces: ParticipantSpaceViewModel[], query: string) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return spaces;
  return spaces.filter((space) => {
    const haystack = [
      space.title,
      space.preview,
      ...space.participants.map((participant) => participant.name),
      ...space.sessions.flatMap((session) => [session.title, session.preview]),
    ].join(' ').toLowerCase();
    return haystack.includes(normalized);
  });
}
```

- [ ] **Step 2: Run the participant-space tests**

Run:

```bash
pnpm --dir app/desktop test:unit -- participantSpaces.test.tsx
```

Expected: PASS.

---

### Task 4: Expose participant spaces from workspace view model

**Files:**
- Modify: `app/desktop/src/app/useWorkspaceViewModels.ts`
- Test: `app/desktop/tests/chatRouting.test.tsx`

- [ ] **Step 1: Add failing workspace-view-model test**

Append this test to `app/desktop/tests/chatRouting.test.tsx`:

```ts
test('workspace view model exposes participant spaces alongside flat chat conversations', () => {
  const result = useWorkspaceViewModels({
    isNativeShell: false,
    isDesktopChatLoading: false,
    desktopChatState: null,
    desktopBridgeState: null,
    canonicalSessionState: null,
    hiddenSessionIds: new Set(),
    projectWorkspaces: [],
    projectSelectedSessionIds: {},
    activeNav: 'chats',
    activeConvId: 'session:bridge:humans:bob',
    activeProjectId: '',
    activeProjectSessionId: '',
    chatFilter: 'all',
    chatSearch: '',
    projectSearch: '',
    contactSearch: '',
    activeContactId: '',
    activeAgentId: '',
    cachedChatSessionMessages: {},
    cachedProjectSessionMessages: {},
    localSessionUnreadCounts: {},
    desktopLiveTurnsBySession: {},
    mapDesktopMessages: () => [],
  });

  assert.ok(result.participantSpaces.length > 0);
  assert.ok(result.participantSpaces[0]?.sessions.length);
});
```

- [ ] **Step 2: Run RED**

Run:

```bash
pnpm --dir app/desktop test:unit -- chatRouting.test.tsx
```

Expected: FAIL because `participantSpaces` is not returned yet.

- [ ] **Step 3: Update `useWorkspaceViewModels.ts`**

Import the helper:

```ts
import { buildParticipantSpaces, filterParticipantSpaces } from '@/features/chat/participantSpaces';
```

Add after `filteredConversations`:

```ts
const participantSpaces = useMemo(() => buildParticipantSpaces(chatConversations), [chatConversations]);
const filteredParticipantSpaces = useMemo(
  () => filterParticipantSpaces(participantSpaces, chatSearch),
  [chatSearch, participantSpaces],
);
```

Return both values from the hook object:

```ts
participantSpaces,
filteredParticipantSpaces,
```

- [ ] **Step 4: Run GREEN**

Run:

```bash
pnpm --dir app/desktop test:unit -- chatRouting.test.tsx participantSpaces.test.tsx
pnpm --dir app/desktop typecheck
```

Expected: PASS.

---

### Task 5: Preserve current sidebar and shell behavior

**Files:**
- Modify only if typecheck requires it:
  - `app/desktop/src/app/kordiShellSlots.types.ts`
  - `app/desktop/src/app/useKordiShellArgs.ts`
  - `app/desktop/src/pages/WorkspaceSidebar.tsx`

- [ ] **Step 1: Do not wire participant spaces into UI yet**

This PR intentionally keeps `WorkspaceSidebar.tsx` on `filteredConversations`. Do not replace visible rows in this plan.

- [ ] **Step 2: Verify no visible route behavior changed**

Run:

```bash
pnpm --dir app/desktop test:unit -- chatRouting.test.tsx participantSpaces.test.tsx
```

Expected: PASS. Existing contact/agent/Bridge entry-point tests remain unchanged.

---

### Task 6: Final verification and commit

- [ ] **Step 1: Run focused verification**

```bash
pnpm --dir app/desktop test:unit -- participantSpaces.test.tsx chatRouting.test.tsx
pnpm --dir app/desktop typecheck
pnpm --dir app/desktop lint
```

Expected: all pass.

- [ ] **Step 2: Run diff check**

```bash
git diff --check
```

Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add \
  app/desktop/src/features/chat/participantSpaces.ts \
  app/desktop/src/kordi-app/types.ts \
  app/desktop/src/app/useWorkspaceViewModels.ts \
  app/desktop/tests/participantSpaces.test.tsx \
  app/desktop/tests/chatRouting.test.tsx \
  docs/superpowers/specs/2026-05-01-chat-participant-spaces-design.md \
  docs/superpowers/plans/2026-05-01-participant-spaces-read-model.md

git commit -m "Add chat participant spaces read model"
```

---

## Post-PR roadmap

After PR 1 merges:

1. PR 2: Sidebar drill-in UI with `filteredParticipantSpaces` first page and selected-space sessions second page.
2. PR 3: Durable backend `participant_spaces` / `participant_space_members` plus `sessions.participant_space_id`.
3. PR 4: `+` create direct/group flows.
4. PR 5: Explicit invite lifecycle and active-human group message fan-out.

## Self-review

- Covers the approved PR 1 scope: yes.
- Avoids backend/UI overreach: yes.
- Defines test-first behavior for every production change: yes.
- Leaves existing routing and flat `chatConversations` intact: yes.
