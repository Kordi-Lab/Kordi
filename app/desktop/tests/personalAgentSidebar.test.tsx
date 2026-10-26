import assert from 'node:assert/strict';
import { test } from 'node:test';

import { act, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { __setSessionBackendForTests } from '../src/features/cloud/session';
import type { ChatSyncConversation } from '../src/features/cloud/chatSyncTypes';
import { buildParticipantSpaces, filterParticipantSpaces } from '../src/features/chat/participantSpaces';
import { personalAgentSessionsFromSnapshots } from '../src/features/personalAgent/personalAgentClient';
import { useAgentBlueprintRequest, requestAgentBlueprint } from '../src/features/personalAgent/agentBlueprintRequest';
import { setPersonalAgentEntries, getPersonalAgentEntries, type PersonalAgentEntry } from '../src/features/personalAgent/personalAgentStore';
import { usePersonalAgentSync } from '../src/features/personalAgent/usePersonalAgentSync';
import type { PersonalAgentSessionPlan } from '../src/features/personalAgent/personalAgentSessions';
import type { Agent, CanonicalSessionState, Conversation } from '../src/kordi-app/types';
import { MainChatHeader } from '../src/pages/chatsPage.mainHeader';
import { useChatHeaderModel } from '../src/pages/useChatHeaderModel';
import { WorkspaceSidebar } from '../src/pages/WorkspaceSidebar';
import { withJsdomRoot } from './helpers/mountWithJsdom';
import { baseSidebarProps, conversation } from './helpers/workspaceSidebarParticipantSpacesFixtures';

const ACCOUNT = 'acct_alex';
const KORDI_SESSION = `session:self-agent:${ACCOUNT}:personal:cloud-agent:${ACCOUNT}`;
const RESEARCH_SESSION = `session:self-agent:${ACCOUNT}:personal:cloud_agent_research`;
const INBOX_SESSION = `session:self-agent:${ACCOUNT}:personal:cloud_agent_inbox`;

const entries: PersonalAgentEntry[] = [
  { agentId: `cloud-agent:${ACCOUNT}`, conversationId: 'conv-kordi', sessionId: KORDI_SESSION, proactive: true, name: "Alex's Kordi", localAgentId: 'desktop:local-agent', avatarSeed: 'cloud-local-agent', profileImageUrl: null, isDefault: true },
  { agentId: 'cloud_agent_research', conversationId: 'conv-research', sessionId: RESEARCH_SESSION, proactive: true, name: 'Research agent', localAgentId: 'cloud-agent:cloud_agent_research', avatarSeed: 'owl', profileImageUrl: null, isDefault: false },
  { agentId: 'cloud_agent_inbox', conversationId: 'conv-inbox', sessionId: INBOX_SESSION, proactive: false, name: 'Inbox helper', localAgentId: 'cloud-agent:cloud_agent_inbox', avatarSeed: 'kingfisher', profileImageUrl: null, isDefault: false },
];

const participants = (agentName: string) => [
  { id: 'human:alex', name: 'Alex', kind: 'human' as const, role: 'self', source: 'local' },
  { id: `agent:${agentName}`, name: agentName, kind: 'agent' as const, role: 'delegate', source: 'local' },
];

function agentChat(id: string, name: string, text: string, overrides: Partial<Conversation> = {}) {
  return conversation({
    id, canonicalSessionId: id, name, type: 'owned-agent', unread: 0, subtitle: text,
    canonicalParticipants: participants(name.includes('Research') ? 'Research agent' : "Alex's Kordi"),
    messages: [{ role: 'owned-agent', sender: "Alex's Kordi", text, time: '14:40' }],
    updatedAtLabel: '14:40', _updatedAtMs: 10,
    ...overrides,
  });
}

function sidebarProps(overrides: Record<string, unknown> = {}) {
  const chatConversations = [
    agentChat(KORDI_SESSION, "Alex's Kordi", 'Lab sync moved to 10 am Thursday.', { unread: 2, metadata: { personalAgent: { agentId: `cloud-agent:${ACCOUNT}` } } }),
    agentChat(RESEARCH_SESSION, 'Research agent', 'Two new papers cite your workshop draft.', { metadata: { personalAgent: { agentId: 'cloud_agent_research' } } }),
    agentChat('session:direct-agent:figure', 'Figure script fix', 'Patched the loader to accept both.'),
  ];
  const spaces = buildParticipantSpaces(chatConversations);
  return baseSidebarProps({
    chatConversations, participantSpaces: spaces, contactParticipantSpaces: [],
    agentParticipantSpaces: filterParticipantSpaces(spaces, '', 'agent'),
    activeConvId: 'session:direct-agent:figure', initialChatChannel: 'agent',
    ...overrides,
  });
}

test('Agent Chats lists the Personal agent section first with one row per agent', () => {
  setPersonalAgentEntries(entries);
  try {
    const markup = renderToStaticMarkup(createElement(WorkspaceSidebar, sidebarProps() as never));
    const personalHeading = markup.indexOf('>Personal agent<');
    const recents = markup.indexOf('Recents');
    assert.ok(personalHeading >= 0 && personalHeading < recents, 'Personal agent comes before Recents');
    assert.doesNotMatch(markup, /PERSONAL AGENT/);
    for (const entry of entries) assert.match(markup, new RegExp(`data-personal-agent-row="${entry.agentId}"`));
    assert.ok(markup.indexOf('data-personal-agent-row="cloud-agent:acct_alex"') < markup.indexOf('data-personal-agent-row="cloud_agent_research"'));
    assert.match(markup, /No messages yet/);
    assert.match(markup, /Lab sync moved to 10 am Thursday\./);
    assert.match(markup, /data-presence-status="online"/);
    assert.match(markup, /data-unread-count="2"/);
    // Personal sessions stay out of the other sections; ordinary chats remain.
    assert.doesNotMatch(markup, new RegExp(`data-agent-session-row="${KORDI_SESSION}"`));
    assert.doesNotMatch(markup, new RegExp(`data-agent-session-row="${RESEARCH_SESSION}"`));
    assert.match(markup, /data-agent-session-row="session:direct-agent:figure"/);
  } finally {
    setPersonalAgentEntries([]);
  }
});

test('a personal row opens its session and its menu offers only read state, mute and Agent settings', async () => {
  setPersonalAgentEntries(entries);
  const selected: string[] = [];
  const unread: Array<[string, boolean]> = [];
  const muted: Array<[string, boolean]> = [];
  const settings: string[] = [];
  try {
    await withJsdomRoot(async (mount) => {
      const host = await mount(createElement(WorkspaceSidebar, sidebarProps({
        onSelectChatSession: (id: string) => selected.push(id),
        onSetChatSessionUnread: (id: string, value: boolean) => unread.push([id, value]),
        onSetChatSessionMuted: (id: string, value: boolean) => muted.push([id, value]),
        onOpenAgentSettings: (id: string) => settings.push(id),
      }) as never));
      const row = (agentId: string) => host.querySelector<HTMLButtonElement>(`[data-personal-agent-row="${agentId}"]`)!;
      await act(async () => { row('cloud_agent_inbox').click(); });
      assert.deepEqual(selected, [INBOX_SESSION]);
      const openMenu = async (agentId: string) => {
        await act(async () => {
          row(agentId).dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 80 }));
        });
        return [...document.querySelectorAll('[data-session-context-action]')].map((item) => item.textContent?.trim());
      };
      assert.deepEqual(await openMenu(`cloud-agent:${ACCOUNT}`), ['Mark as read', 'Mute', 'Agent settings']);
      assert.equal(document.body.textContent?.includes('Rename'), false);
      assert.equal(document.body.textContent?.includes('Archive'), false);
      assert.equal(document.body.textContent?.includes('Delete chat'), false);
      await act(async () => { document.querySelector<HTMLButtonElement>('[data-session-context-action="read"]')!.click(); });
      assert.deepEqual(unread, [[KORDI_SESSION, false]]);
      await openMenu('cloud_agent_research');
      await act(async () => { document.querySelector<HTMLButtonElement>('[data-session-context-action="mute"]')!.click(); });
      assert.deepEqual(muted, [[RESEARCH_SESSION, true]]);
      await openMenu('cloud_agent_research');
      await act(async () => { document.querySelector<HTMLButtonElement>('[data-session-context-action="agent-settings"]')!.click(); });
      assert.deepEqual(settings, ['cloud-agent:cloud_agent_research']);
      assert.equal(document.querySelector('[data-session-context-action]'), null);
    });
  } finally {
    setPersonalAgentEntries([]);
  }
});

function headerConversation() {
  return agentChat(RESEARCH_SESSION, 'Two new papers', 'Two new papers cite your workshop draft.', { metadata: { personalAgent: { agentId: 'cloud_agent_research' } } });
}

test('a personal session header shows the agent avatar, name and Online, and cannot be renamed', () => {
  setPersonalAgentEntries(entries);
  try {
    const props = {
      conversation: headerConversation(),
      layout: { showSessionToggle: false, sessionsCollapsed: false, onToggleSessions: () => undefined, showDestinations: false, destination: 'chat', onSelectDestination: () => undefined },
      metadata: { subtitle: 'Online', forkSourceSessionId: null, forkSourceTitle: '' },
      rename: { enabled: false, editing: false, draft: '', sessionId: RESEARCH_SESSION, setDraft: () => undefined, begin: () => undefined, cancel: () => undefined, commit: () => undefined },
      companion: { view: 'chat', isOpen: false, canOpenChat: false, hasChat: false, onSelect: () => undefined, onHide: () => undefined },
    };
    const markup = renderToStaticMarkup(createElement(MainChatHeader, props as never));
    assert.match(markup, /data-personal-agent-header="cloud_agent_research"/);
    assert.match(markup, /<h2 title="Research agent">Research agent<\/h2>/);
    assert.match(markup, />Online</);
    assert.match(markup, /data-presence-status="online"/);
    assert.doesNotMatch(markup, /Two new papers/);
    assert.doesNotMatch(markup, /data-chat-session-title-rename/);

    let model: ReturnType<typeof useChatHeaderModel> | null = null;
    renderToStaticMarkup(createElement(() => {
      model = useChatHeaderModel({
        isNativeShell: true, isSending: false,
        session: {
          activeConv: headerConversation(), isEditingDesktopSessionTitle: false, setIsEditingDesktopSessionTitle: () => undefined,
          desktopSessionRenameDraft: '', setDesktopSessionRenameDraft: () => undefined,
          onRenameDesktopSession: async () => undefined, onRenameChatSession: async () => undefined,
        } as never,
      });
      return null;
    }));
    assert.equal(model!.subtitle, 'Online');
    assert.equal(model!.rename.enabled, false);
  } finally {
    setPersonalAgentEntries([]);
  }
});

const kordi = { id: 'desktop:local-agent', name: "Alex's Kordi", isOwned: true, role: 'Assistant', loadedTools: [], loadedSkills: [], loadedPlugins: [] } as unknown as Agent;
const research = { id: 'cloud-agent:cloud_agent_research', name: 'Research agent', isOwned: true, cloudAgentId: 'cloud_agent_research', role: 'Research', systemPrompt: 'Read papers.', loadedTools: [], loadedSkills: [], loadedPlugins: [] } as unknown as Agent;

const state = {
  profile: { humanIdentityId: 'human:alex', activeAgentIdentityId: 'agent:local' },
  identities: [{ id: 'agent:local', kind: 'agent', displayName: "Alex's Kordi", ownerIdentityId: 'human:alex' }],
  sessions: [], participants: [], messages: [], contextSnapshots: [],
} as unknown as CanonicalSessionState;

async function flush() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

test('the sync loads the list on sign-in, publishes entries and prepares one local session per agent', async () => {
  __setSessionBackendForTests({ load: async () => ({ token: 'token-alex', accountId: ACCOUNT, expiresAt: '2099-01-01T00:00:00Z' }), save: async () => undefined, clear: async () => undefined });
  const tokens: string[] = [];
  const planned: PersonalAgentSessionPlan[] = [];
  const snapshot = {
    id: 'conv-cached', kind: 'ai', legacy_session_id: KORDI_SESSION, personal_agent: { agent_id: `cloud-agent:${ACCOUNT}` },
  } as unknown as ChatSyncConversation;
  let resolveList: (value: typeof entries) => void = () => undefined;
  const list = (token: string) => { tokens.push(token); return new Promise<typeof entries>((resolve) => { resolveList = resolve; }); };
  function Harness({ canCreate }: { canCreate: boolean }) {
    usePersonalAgentSync({
      accountId: ACCOUNT, agents: [kordi, research], canonicalState: state, setCanonicalState: () => undefined,
      canCreateSessions: canCreate, list,
      loadCachedConversations: async () => [snapshot],
      createSession: async (plan) => { planned.push(plan); return (current) => current; },
    });
    return null;
  }
  try {
    await withJsdomRoot(async (mount) => {
      await mount(createElement(Harness, { canCreate: false }));
      await flush();
      // Cached snapshots name the default agent's session before the list loads.
      assert.deepEqual(getPersonalAgentEntries().map((entry) => entry.sessionId), [KORDI_SESSION]);
      assert.deepEqual(tokens, ['token-alex']);
      assert.equal(planned.length, 0);
      await act(async () => { resolveList(entries.slice(0, 2)); });
      await flush();
      assert.deepEqual(getPersonalAgentEntries().map((entry) => entry.name), ["Alex's Kordi", 'Research agent']);
      await mount(createElement(Harness, { canCreate: true }));
      await flush();
      assert.deepEqual(planned.map((plan) => [plan.session.id, plan.session.kind]), [[KORDI_SESSION, 'self-agent'], [RESEARCH_SESSION, 'direct-agent']]);
    });
  } finally {
    __setSessionBackendForTests(null);
    setPersonalAgentEntries([]);
  }
});

test('cached snapshots name personal sessions with the snake_case personal_agent field', () => {
  const sessions = personalAgentSessionsFromSnapshots([
    { id: 'conv-1', kind: 'ai', legacy_session_id: RESEARCH_SESSION, personal_agent: { agent_id: 'cloud_agent_research' } },
    { id: 'conv-2', kind: 'ai', legacy_session_id: 'session:self-agent:other', personal_agent: null },
    { id: 'conv-3', kind: 'group', legacy_session_id: 'session:group:x', personal_agent: { agent_id: 'cloud_agent_x' } },
    { id: 'conv-4', kind: 'ai', legacy_session_id: null, personal_agent: { agent_id: 'cloud_agent_y' } },
  ] as unknown as ChatSyncConversation[]);
  assert.deepEqual(sessions, [{ agentId: 'cloud_agent_research', conversationId: 'conv-1', sessionId: RESEARCH_SESSION, proactive: false }]);
});

test('Agent settings opens the Blueprint once the Agents page has the agent', async () => {
  const opened: string[] = [];
  function Page({ agents }: { agents: Agent[] }) {
    useAgentBlueprintRequest(agents, (agent) => opened.push(agent.id));
    return null;
  }
  await withJsdomRoot(async (mount) => {
    await mount(createElement(Page, { agents: [kordi] }));
    await act(async () => { requestAgentBlueprint(research.id); });
    assert.deepEqual(opened, []);
    await mount(createElement(Page, { agents: [kordi, research] }));
    assert.deepEqual(opened, [research.id]);
    await mount(createElement(Page, { agents: [research, kordi] }));
    assert.deepEqual(opened, [research.id]);
  });
});
