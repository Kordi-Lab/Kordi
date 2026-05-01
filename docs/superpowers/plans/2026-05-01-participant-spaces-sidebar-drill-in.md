# Participant Spaces Sidebar Drill-In Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Chats sidebar's flat first-level session list with participant-space rows and add a Back-driven drill-in view for sessions inside a selected space.

**Architecture:** Keep transcript routing and `chatConversations` unchanged. Pass the additive `participantSpaces` read model into the sidebar, render participant spaces as the first pane, and use local sidebar state for the selected/drilled participant space. Child session rows still call `handleSelectChatSession(session.id)` with existing conversation ids.

**Tech Stack:** React 19, TypeScript, existing Kordi desktop view-model utilities, Node `tsx --test` unit tests.

---

## Scope

This is PR 2 of #171.

In scope:

- Filter participant spaces by the existing chat filter tabs.
- Pass `participantSpaces` / `filteredParticipantSpaces` through shell args into `WorkspaceSidebar`.
- Render a participant-space first pane in Chats.
- Render a selected-space session pane with Back.
- Preserve existing chat selection, context menu, archive/delete/move behavior for child session rows.
- Refresh the two QA instances after the UI change so user1/user2 can test.

Out of scope:

- Durable backend group persistence.
- Group creation or invite dialogs.
- Group fan-out messaging.
- Replacing transcript behavior.

## File map

- Modify: `app/desktop/src/features/chat/participantSpaces.ts`
  - Add chat-filter matching to `filterParticipantSpaces()`.
- Modify: `app/desktop/tests/participantSpaces.test.tsx`
  - Add RED/GREEN coverage for chat filters.
- Create: `app/desktop/tests/workspaceSidebarParticipantSpaces.test.tsx`
  - Static-render sidebar tests proving participant-space rows replace flat rows.
- Modify: `app/desktop/src/app/useWorkspaceViewModels.ts`
  - Use chat filter when deriving `filteredParticipantSpaces`.
- Modify: `app/desktop/src/app/kordiShellSlots.types.ts`
  - Add participant-space types to shell args and sidebar args.
- Modify: `app/desktop/src/app/useKordiAppModel.ts`
  - Destructure and forward participant spaces.
- Modify: `app/desktop/src/app/useKordiShellArgs.ts`
  - Forward participant spaces into `sidebar` args.
- Modify: `app/desktop/src/app/assembleSidebarSlot.tsx`
  - Pass participant spaces into `WorkspaceSidebar`.
- Modify: `app/desktop/src/pages/WorkspaceSidebar.tsx`
  - Add participant-space pane, avatar stack, selected-space pane, and Back interaction.

---

### Task 1: Filter participant spaces by chat filter

**Files:**
- Modify: `app/desktop/tests/participantSpaces.test.tsx`
- Modify: `app/desktop/src/features/chat/participantSpaces.ts`
- Modify: `app/desktop/src/app/useWorkspaceViewModels.ts`

- [ ] **Step 1: Write the failing test**

Append to `app/desktop/tests/participantSpaces.test.tsx`:

```ts
test('filterParticipantSpaces applies chat filter tabs to spaces', () => {
  const spaces = buildParticipantSpaces([
    conversation({
      id: 'session:bob-person',
      type: 'person',
      name: 'Bob',
      _updatedAtMs: 3,
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'human:bob', name: 'Bob', kind: 'human', role: 'delegate', source: 'bridge', avatarKey: 'bob' },
      ],
    }),
    conversation({
      id: 'session:bob-agent',
      type: 'external-agent',
      name: "Bob's Kordi",
      participants: ['Me', "Bob's Kordi"],
      _updatedAtMs: 2,
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'agent:bob-kordi', name: "Bob's Kordi", kind: 'agent', role: 'delegate', source: 'bridge', avatarKey: 'agent-bob' },
      ],
    }),
    conversation({
      id: 'session:design-group',
      type: 'person',
      name: 'Design group',
      participants: ['Me', 'Bob', "Bob's Kordi"],
      _updatedAtMs: 1,
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'human:bob', name: 'Bob', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'bob' },
        { id: 'agent:bob-kordi', name: "Bob's Kordi", kind: 'agent', role: 'delegate', source: 'bridge', avatarKey: 'agent-bob' },
      ],
    }),
  ]);

  assert.deepEqual(filterParticipantSpaces(spaces, '', 'people').map((space) => space.kind), ['direct-human']);
  assert.deepEqual(filterParticipantSpaces(spaces, '', 'agents').map((space) => space.kind), ['direct-agent']);
  assert.deepEqual(filterParticipantSpaces(spaces, '', 'delegated').map((space) => space.kind), ['group']);
  assert.equal(filterParticipantSpaces(spaces, 'design', 'people').length, 0);
});
```

- [ ] **Step 2: Run RED**

Run:

```bash
pnpm --dir app/desktop test:unit -- participantSpaces.test.tsx
```

Expected: FAIL because `filterParticipantSpaces()` ignores the third chat-filter argument.

- [ ] **Step 3: Implement chat-filter matching**

In `app/desktop/src/features/chat/participantSpaces.ts`, import `ChatFilter` and update filtering:

```ts
import type {
  ChatFilter,
  Conversation,
  ConversationParticipant,
  ParticipantSpaceAvatar,
  ParticipantSpaceKind,
  ParticipantSpaceSessionViewModel,
  ParticipantSpaceViewModel,
} from '@/kordi-app/types';
```

Add:

```ts
function spaceMatchesChatFilter(space: ParticipantSpaceViewModel, chatFilter: ChatFilter) {
  if (chatFilter === 'all') return true;
  if (chatFilter === 'people') return space.kind === 'direct-human';
  if (chatFilter === 'agents') return space.kind === 'direct-agent';
  return space.kind === 'group'
    || space.sessions.some((session) => session.conversation.directness !== 'Direct chat');
}
```

Change the export signature/body:

```ts
export function filterParticipantSpaces(
  spaces: ParticipantSpaceViewModel[],
  query: string,
  chatFilter: ChatFilter = 'all',
) {
  const normalized = query.trim().toLowerCase();
  return spaces.filter((space) => {
    if (!spaceMatchesChatFilter(space, chatFilter)) return false;
    if (!normalized) return true;
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

In `app/desktop/src/app/useWorkspaceViewModels.ts`, pass `chatFilter`:

```ts
const filteredParticipantSpaces = useMemo(
  () => filterParticipantSpaces(participantSpaces, chatSearch, chatFilter),
  [chatFilter, chatSearch, participantSpaces],
);
```

- [ ] **Step 4: Run GREEN**

Run:

```bash
pnpm --dir app/desktop test:unit -- participantSpaces.test.tsx
pnpm --dir app/desktop typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/desktop/src/features/chat/participantSpaces.ts app/desktop/src/app/useWorkspaceViewModels.ts app/desktop/tests/participantSpaces.test.tsx docs/superpowers/plans/2026-05-01-participant-spaces-sidebar-drill-in.md
git commit -m "Filter chat participant spaces by tab"
```

---

### Task 2: Add sidebar participant-space rendering tests

**Files:**
- Create: `app/desktop/tests/workspaceSidebarParticipantSpaces.test.tsx`

- [ ] **Step 1: Write the failing static-render test**

Create `app/desktop/tests/workspaceSidebarParticipantSpaces.test.tsx`:

```tsx
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { buildParticipantSpaces } from '../src/features/chat/participantSpaces';
import type { Conversation } from '../src/kordi-app/types';
import { WorkspaceSidebar } from '../src/pages/WorkspaceSidebar';

type ConversationFixture = Conversation & { _updatedAtMs?: number };

function conversation(overrides: Partial<ConversationFixture> = {}): ConversationFixture {
  return {
    id: 'session:bob:old',
    canonicalSessionId: 'session:bob:old',
    name: 'Old Bob thread',
    type: 'person',
    subtitle: 'Old preview',
    unread: 1,
    bridges: ['Bridge'],
    trust: 'Bridge',
    directness: 'Direct chat',
    participants: ['Me', 'Bob'],
    canonicalParticipants: [
      { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
      { id: 'human:bob', name: 'Bob', kind: 'human', role: 'delegate', source: 'bridge', avatarKey: 'bob' },
    ],
    messages: [{ role: 'person', sender: 'Bob', text: 'Old preview', time: '09:00' }],
    updatedAtLabel: '09:00',
    _updatedAtMs: 1,
    ...overrides,
  };
}

function baseSidebarProps(overrides: Record<string, unknown> = {}) {
  const chatConversations = [
    conversation(),
    conversation({
      id: 'session:bob:new',
      canonicalSessionId: 'session:bob:new',
      name: 'New Bob thread',
      subtitle: 'New preview',
      unread: 2,
      messages: [{ role: 'person', sender: 'Bob', text: 'New preview', time: '10:00' }],
      updatedAtLabel: '10:00',
      _updatedAtMs: 2,
    }),
  ];
  const participantSpaces = buildParticipantSpaces(chatConversations);

  return {
    isNativeShell: false,
    isSingleWorkspacePage: false,
    collapseChatSessions: false,
    showSessionRail: true,
    sessionRailWidth: 248,
    activeNav: 'chats',
    setActiveNav: () => {},
    chatConversations,
    participantSpaces,
    onCreateChatSession: () => {},
    chatSearch: '',
    setChatSearch: () => {},
    chatFilter: 'all',
    setChatFilter: () => {},
    isDesktopChatLoading: false,
    desktopChatError: null,
    filteredConversations: chatConversations,
    filteredParticipantSpaces: participantSpaces,
    activeConvId: 'session:bob:new',
    onSelectChatSession: () => {},
    onArchiveChatSession: () => {},
    onDeleteChatSession: () => {},
    onMoveChatSessionToProject: () => {},
    onCreateProjectFromFolder: () => {},
    onCreateProject: () => {},
    runtimeProjects: [],
    projectSearch: '',
    setProjectSearch: () => {},
    filteredProjects: [],
    activeProjectId: '',
    activeProjectSessionId: '',
    projectSelectedSessionIds: {},
    selectProject: () => {},
    expandedProjectIds: {},
    setExpandedProjectIds: () => {},
    onSelectProjectSession: () => {},
    groupedContacts: [],
    displayedContacts: [],
    setActiveContactGroup: () => {},
    setActiveContactId: () => {},
    displayedAgents: [],
    activeBridgeHost: null,
    localProfileAvatarSeed: 'me',
    onRefreshBridge: () => {},
    onCopyBridgeHostUrl: () => {},
    onCreateBridgeDraft: () => {},
    ...overrides,
  };
}

test('WorkspaceSidebar renders participant spaces as the Chats first level', () => {
  const markup = renderToStaticMarkup(createElement(WorkspaceSidebar, baseSidebarProps() as never));

  assert.match(markup, /data-chat-sidebar-mode="participant-spaces"/);
  assert.match(markup, /Bob/);
  assert.match(markup, /2 sessions/);
  assert.match(markup, /New preview/);
  assert.doesNotMatch(markup, /Old Bob thread/);
  assert.doesNotMatch(markup, /New Bob thread/);
});
```

- [ ] **Step 2: Run RED**

Run:

```bash
pnpm --dir app/desktop test:unit -- workspaceSidebarParticipantSpaces.test.tsx
```

Expected: FAIL because sidebar still renders flat sessions and lacks participant-space markup.

---

### Task 3: Pass participant spaces into the sidebar shell

**Files:**
- Modify: `app/desktop/src/app/kordiShellSlots.types.ts`
- Modify: `app/desktop/src/app/useKordiAppModel.ts`
- Modify: `app/desktop/src/app/useKordiShellArgs.ts`
- Modify: `app/desktop/src/app/assembleSidebarSlot.tsx`

- [ ] **Step 1: Add shell arg types**

In `app/desktop/src/app/kordiShellSlots.types.ts`, import the type:

```ts
  ParticipantSpaceViewModel,
```

Add to `AssembleKordiShellSlotsArgs` near chat conversations:

```ts
  participantSpaces: ParticipantSpaceViewModel[];
  filteredParticipantSpaces: ParticipantSpaceViewModel[];
```

Add to `SidebarShellArgs` pick list:

```ts
  | 'participantSpaces'
  | 'filteredParticipantSpaces'
```

- [ ] **Step 2: Forward through `useKordiAppModel.ts`**

Destructure from `useWorkspaceViewModels()`:

```ts
participantSpaces,
filteredParticipantSpaces,
```

Pass into `useKordiShellArgs({ ... })` near `filteredConversations`:

```ts
participantSpaces,
filteredParticipantSpaces,
```

- [ ] **Step 3: Forward through `useKordiShellArgs.ts`**

Add to `sidebar` args near `filteredConversations`:

```ts
participantSpaces: args.participantSpaces,
filteredParticipantSpaces: args.filteredParticipantSpaces,
```

- [ ] **Step 4: Forward through `assembleSidebarSlot.tsx`**

Add props to `WorkspaceSidebar`:

```tsx
participantSpaces={args.participantSpaces}
filteredParticipantSpaces={args.filteredParticipantSpaces}
```

- [ ] **Step 5: Run typecheck**

Run:

```bash
pnpm --dir app/desktop typecheck
```

Expected: FAIL until `WorkspaceSidebar` accepts the new props; then continue Task 4.

---

### Task 4: Implement participant-space panes in `WorkspaceSidebar`

**Files:**
- Modify: `app/desktop/src/pages/WorkspaceSidebar.tsx`
- Test: `app/desktop/tests/workspaceSidebarParticipantSpaces.test.tsx`

- [ ] **Step 1: Import needed types and icon**

Update imports:

```tsx
import {
  Activity,
  ChevronDown,
  ChevronLeft,
  Copy,
  Plus,
  Search,
} from 'lucide-react';
```

And type import:

```ts
import type { ChatFilter, ContactClass, ConversationType, NavId, ParticipantSpaceViewModel, SessionStatusIndicator } from '@/kordi-app/types';
```

- [ ] **Step 2: Add prop types**

After `ConversationItem`, add:

```ts
type ParticipantSpaceItem = ParticipantSpaceViewModel;
```

In `WorkspaceSidebarProps`, add near `filteredConversations`:

```ts
  participantSpaces: ParticipantSpaceItem[];
  filteredParticipantSpaces: ParticipantSpaceItem[];
```

Destructure both props.

- [ ] **Step 3: Add helper components/functions**

Add above `WorkspaceSidebar`:

```tsx
function pluralize(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function participantSpaceKindText(space: ParticipantSpaceItem) {
  if (space.kind === 'direct-human') return 'Person';
  if (space.kind === 'direct-agent') return 'Agent';
  return 'Group';
}

function ParticipantSpaceAvatarStack({ space }: { space: ParticipantSpaceItem }) {
  const avatars = space.avatarStack.length > 0
    ? space.avatarStack
    : [{ kind: space.kind === 'direct-agent' ? 'agent' as const : 'human' as const, seed: space.id, imageUrl: null }];

  if (avatars.length === 1) {
    const avatar = avatars[0];
    return (
      <IdentityAvatar
        kind={avatar.kind}
        seed={avatar.seed}
        name={space.title}
        imageUrl={avatar.imageUrl ?? undefined}
        className="h-9 w-9 border border-white/10"
      />
    );
  }

  return (
    <div className="flex h-9 w-11 items-center -space-x-4" aria-hidden="true">
      {avatars.slice(0, 3).map((avatar, index) => (
        <IdentityAvatar
          key={`${avatar.seed}-${index}`}
          kind={avatar.kind}
          seed={avatar.seed}
          name={space.title}
          imageUrl={avatar.imageUrl ?? undefined}
          className="h-8 w-8 border border-slate-950/80 shadow-[0_0_0_1px_rgba(255,255,255,0.08)]"
          style={{ zIndex: avatars.length - index }}
        />
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Add selected-space state**

Inside `WorkspaceSidebar`, after dialog state:

```tsx
const [selectedParticipantSpaceId, setSelectedParticipantSpaceId] = useState<string | null>(null);
const activeParticipantSpaceId = participantSpaces.find((space) => (
  space.sessions.some((session) => session.id === activeConvId || session.canonicalSessionId === activeConvId)
))?.id ?? null;
const selectedParticipantSpace = selectedParticipantSpaceId
  ? participantSpaces.find((space) => space.id === selectedParticipantSpaceId) ?? null
  : null;
```

Add effect:

```tsx
useEffect(() => {
  if (selectedParticipantSpaceId && !participantSpaces.some((space) => space.id === selectedParticipantSpaceId)) {
    setSelectedParticipantSpaceId(null);
  }
}, [participantSpaces, selectedParticipantSpaceId]);
```

- [ ] **Step 5: Replace the chat scroll body with two panes**

Replace only the current `ScrollArea` that maps `filteredConversations.map(...)` in the Chats section with a relative two-pane container:

```tsx
<div className="relative min-h-0 flex-1 overflow-hidden" data-chat-sidebar-mode="participant-spaces">
  <div className={cn(
    'absolute inset-0 min-h-0 transition duration-200 ease-out motion-reduce:transition-none',
    selectedParticipantSpace ? 'pointer-events-none -translate-x-5 opacity-0' : 'translate-x-0 opacity-100',
  )}>
    <ScrollArea className="app-workspace-session-scroll h-full min-h-0">
      <div className="w-full space-y-1">
        {filteredParticipantSpaces.length > 0 ? filteredParticipantSpaces.map((space) => {
          const latestSession = space.sessions[0];
          const isActiveSpace = activeParticipantSpaceId === space.id;
          const isSelectedSpace = selectedParticipantSpaceId === space.id;
          const rowTimeLabel = space.updatedAtLabel ?? latestSession?.updatedAtLabel ?? '--:--';
          return (
            <button
              key={space.id}
              type="button"
              data-testid="participant-space-row"
              onClick={() => {
                setSelectedParticipantSpaceId(space.id);
                if (latestSession && activeConvId !== latestSession.id) {
                  onSelectChatSession(latestSession.id);
                }
              }}
              className={cn(
                'app-session-row block w-full px-2.5 py-2 text-left text-white',
                (isActiveSpace || isSelectedSpace) && 'app-session-row-active',
              )}
            >
              <div className="flex items-start gap-2.5">
                <ParticipantSpaceAvatarStack space={space} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-start gap-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[12px] font-medium text-slate-100" title={space.title}>{space.title}</div>
                      <div className={cn('mt-px truncate text-[10.5px] leading-[1.05rem]', isActiveSpace || isSelectedSpace ? 'text-slate-300' : 'text-slate-500')} title={space.preview}>
                        {space.preview || `${participantSpaceKindText(space)} space`}
                      </div>
                      <div className="mt-px truncate text-[10px] leading-[0.95rem] text-slate-600">
                        {participantSpaceKindText(space)} • {pluralize(space.sessionCount, 'session')}
                      </div>
                    </div>
                    <SidebarSessionMetaColumn
                      timeLabel={rowTimeLabel}
                      unreadCount={space.unread}
                      indicator={latestSession?.statusIndicator}
                      active={isActiveSpace || isSelectedSpace}
                    />
                  </div>
                </div>
              </div>
            </button>
          );
        }) : (
          <div className="rounded-[14px] border border-white/10 bg-white/[0.03] px-3 py-3 text-[11px] text-slate-400">
            No chat spaces match this filter.
          </div>
        )}
      </div>
    </ScrollArea>
  </div>

  <div className={cn(
    'absolute inset-0 min-h-0 transition duration-200 ease-out motion-reduce:transition-none',
    selectedParticipantSpace ? 'translate-x-0 opacity-100' : 'pointer-events-none translate-x-5 opacity-0',
  )}>
    {selectedParticipantSpace ? (
      <div className="flex h-full min-h-0 flex-col">
        <div className="mb-2 rounded-[16px] border border-white/10 bg-white/[0.035] px-2.5 py-2">
          <button
            type="button"
            onClick={() => setSelectedParticipantSpaceId(null)}
            className="mb-1 inline-flex items-center gap-1 text-[11px] font-medium text-slate-400 transition hover:text-white"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            Back to chats
          </button>
          <div className="flex items-center gap-2.5">
            <ParticipantSpaceAvatarStack space={selectedParticipantSpace} />
            <div className="min-w-0">
              <div className="truncate text-[13px] font-semibold text-white" title={selectedParticipantSpace.title}>{selectedParticipantSpace.title}</div>
              <div className="mt-px text-[10.5px] text-slate-500">
                {participantSpaceKindText(selectedParticipantSpace)} • {pluralize(selectedParticipantSpace.sessionCount, 'session')}
              </div>
            </div>
          </div>
        </div>

        <ScrollArea className="app-workspace-session-scroll min-h-0 flex-1">
          <div className="w-full space-y-1">
            {selectedParticipantSpace.sessions.map((session) => {
              const conversation = session.conversation;
              const isActive = activeConvId === session.id || activeConvId === session.canonicalSessionId;
              const rowTimeLabel = session.updatedAtLabel ?? conversation.updatedAtLabel ?? '--:--';
              const sessionSubtitle = formatSessionIdSubtitle(session.preview);
              return (
                <button
                  key={session.id}
                  type="button"
                  data-testid="participant-space-session-row"
                  onClick={() => onSelectChatSession(session.id)}
                  onContextMenu={(event) => {
                    if (!isManageableLocalChatConversation(conversation)) return;
                    event.preventDefault();
                    event.stopPropagation();
                    setSessionContextMenu({
                      sessionId: conversation.id,
                      sessionName: conversation.name,
                      x: event.clientX,
                      y: event.clientY,
                    });
                  }}
                  className={cn('app-session-row block w-full px-2.5 py-[0.3125rem] text-left text-white', isActive && 'app-session-row-active')}
                >
                  <div className="flex items-start">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start gap-2.5">
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[12px] font-medium text-slate-100" title={session.title}>{session.title}</div>
                        </div>
                        <SidebarSessionMetaColumn
                          timeLabel={rowTimeLabel}
                          unreadCount={session.unread}
                          indicator={session.statusIndicator}
                          active={isActive}
                        />
                      </div>
                      {sessionSubtitle ? (
                        <div className={cn('mt-px truncate font-mono text-[10.5px] leading-[1.05rem]', isActive ? 'text-slate-300' : 'text-slate-500')} title={sessionSubtitle}>
                          {sessionSubtitle}
                        </div>
                      ) : null}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </ScrollArea>
      </div>
    ) : null}
  </div>
</div>
```

- [ ] **Step 6: Keep flat fallback if needed**

Do not remove `filteredConversations` prop or flat `ConversationItem` helpers. They are still part of routing/tests and a safe fallback during later refactors.

- [ ] **Step 7: Run GREEN**

Run:

```bash
pnpm --dir app/desktop test:unit -- workspaceSidebarParticipantSpaces.test.tsx participantSpaces.test.tsx chatRouting.test.tsx
pnpm --dir app/desktop typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add app/desktop/src/app/kordiShellSlots.types.ts app/desktop/src/app/useKordiAppModel.ts app/desktop/src/app/useKordiShellArgs.ts app/desktop/src/app/assembleSidebarSlot.tsx app/desktop/src/pages/WorkspaceSidebar.tsx app/desktop/tests/workspaceSidebarParticipantSpaces.test.tsx
git commit -m "Add participant-space drill-in sidebar"
```

---

### Task 5: Refresh QA instances and document testing steps

**Files:**
- Runtime only; no tracked files.

- [ ] **Step 1: Stop current user1/user2 instances without reset**

Run from the PR worktree, using the main config so existing user data dirs are preserved:

```bash
cd /Users/shuyang/kordi-worktrees/issue-171-sidebar-participant-spaces
node app/desktop/scripts/multi-instance/launch.mjs --config /Users/shuyang/kordi/app/desktop/scripts/multi-instance/configs/users.yaml --users user1,user2 --dry-run
```

Then stop the existing pid groups from `/Users/shuyang/kordi/app/desktop/.multi-instance-runtime/user1.pid` and `user2.pid` manually if launch reports ports busy.

- [ ] **Step 2: Relaunch user1/user2 from this PR branch, preserving data**

```bash
cd /Users/shuyang/kordi-worktrees/issue-171-sidebar-participant-spaces
pnpm --dir app/desktop tauri:dev:multi -- --config /Users/shuyang/kordi/app/desktop/scripts/multi-instance/configs/users.yaml --users user1,user2
```

Expected:

- user1: `http://127.0.0.1:1482/`
- user2: `http://127.0.0.1:1484/`
- Data dirs remain under `/Users/shuyang/kordi/app/desktop/.multi-instance-data/user1` and `user2`.

- [ ] **Step 3: Smoke-check HTTP**

```bash
curl -s -o /dev/null -w 'user1 %{http_code}\n' http://127.0.0.1:1482/
curl -s -o /dev/null -w 'user2 %{http_code}\n' http://127.0.0.1:1484/
```

Expected: both `200`.

- [ ] **Step 4: Tell the user how to test**

Manual QA script:

1. Open user1 at `http://127.0.0.1:1482/` and user2 at `http://127.0.0.1:1484/`.
2. Go to Chats.
3. Confirm the left Chats panel first shows people/agents/groups, not individual thread titles.
4. Find a person with multiple sessions (for example Bob, if present). The row should show aggregated unread/session count.
5. Click the space row. It should drill into a thread list for that participant and select the latest session.
6. Click Back to chats. The participant-space list should return.
7. Use the People/Agents tabs and search box. The visible space list should filter accordingly.
8. Open a child session and send a normal message; transcript behavior should be unchanged.

---

### Task 6: Final verification and PR

- [ ] **Step 1: Run full frontend verification**

```bash
pnpm --dir app/desktop test:unit
pnpm --dir app/desktop typecheck
pnpm --dir app/desktop lint
pnpm --dir app/desktop build
git diff --check
```

Expected: PASS. Existing Vite large chunk warning is acceptable.

- [ ] **Step 2: Push and open PR**

```bash
git push -u origin feature/issue-171-sidebar-participant-spaces
```

Create PR with title:

```text
Add participant-space drill-in sidebar
```

Use `Refs #171`, not `Closes #171`.

### Task 7: Human-centered participant spaces and default self space

**Files:**
- Modify: `app/desktop/src/kordi-app/types.ts`
- Modify: `app/desktop/src/features/chat/participantSpaces.ts`
- Modify: `app/desktop/src/pages/WorkspaceSidebar.tsx`
- Modify: `app/desktop/tests/participantSpaces.test.tsx`
- Modify: `app/desktop/tests/workspaceSidebarParticipantSpaces.test.tsx`

- [ ] **Step 1: Write the failing read-model tests**

Add tests proving:

```ts
assert.equal(spaces[0]?.id, 'direct-human:human:shu');
assert.equal(spaces[0]?.kind, 'direct-human');
assert.equal(spaces[0]?.title, 'shu');
assert.deepEqual(spaces[0]?.avatarStack.map((avatar) => avatar.seed), ['shu']);
```

for a session containing `Me`, one other human, and an agent; add tests proving agent-only sessions collapse into:

```ts
assert.equal(spaces[0]?.id, 'self:local');
assert.equal(spaces[0]?.kind, 'self');
assert.equal(spaces[0]?.title, 'Myself');
assert.deepEqual(spaces[0]?.sessions.map((session) => session.id), ['session:any-agent', 'session:my-kordi']);
```

Run:

```bash
pnpm --dir app/desktop test:unit -- participantSpaces.test.tsx workspaceSidebarParticipantSpaces.test.tsx
```

Expected: FAIL against the old grouping logic.

- [ ] **Step 2: Implement the read-model change**

Add `self` to `ParticipantSpaceKind`. In `participantSpaces.ts`, compute non-self humans and agents separately. Classify a session as:

```ts
if (conversation.participantSpaceId || nonSelfHumanCount > 1) return 'group';
if (nonSelfHumanCount === 1) return 'direct-human';
return 'self';
```

Use `self:local` as the stable default self-space id. Use `Myself` as the self-space title. For avatars, return the self avatar for `self`, the other human avatar for `direct-human`, and non-self participants for true groups.

- [ ] **Step 3: Polish the sidebar labels and avatars**

In `WorkspaceSidebar.tsx`, render detail text as:

```ts
Person + 1 agent • 1 session
Myself + 2 agents • 2 sessions
Group • 2 people • 1 session
```

Show a single primary avatar for self/person rows and a small `+N` agent badge instead of a large stacked avatar treatment.

- [ ] **Step 4: Run GREEN**

Run:

```bash
pnpm --dir app/desktop test:unit -- participantSpaces.test.tsx workspaceSidebarParticipantSpaces.test.tsx
pnpm --dir app/desktop typecheck
```

Expected: PASS.

## Self-review

- PR2 scope only: yes.
- Existing transcript routing preserved: yes.
- No backend group persistence: yes.
- No invite/fan-out behavior: yes.
- Human-centered person + agent grouping covered: yes.
- Default self space for agent-only sessions covered: yes.
- QA refresh included: yes.
