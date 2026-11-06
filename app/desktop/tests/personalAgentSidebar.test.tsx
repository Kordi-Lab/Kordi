import assert from 'node:assert/strict';
import { test } from 'node:test';

import { act, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { __setSessionBackendForTests } from '../src/features/cloud/session';
import type { ChatSyncConversation } from '../src/features/cloud/chatSyncTypes';
import { buildParticipantSpaces, filterParticipantSpaces } from '../src/features/chat/participantSpaces';
import { personalAgentSessionsFromSnapshots, type PersonalAgentStatus } from '../src/features/personalAgent/personalAgentClient';
import { PersonalAgentPage } from '../src/features/personalAgent/PersonalAgentPage';
import { __setDefaultPersonalAgentStatusForTests } from '../src/features/personalAgent/personalAgentStatus';
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

const watching: PersonalAgentStatus = {
  proactive: true, connected: true, checkedAt: null,
  sources: [{ connectorId: 'c-mail', provider: 'gmail', status: 'connected' }, { connectorId: 'c-cal', provider: 'google_calendar', status: 'connected' }],
  recent: [{ at: '2026-11-06T14:40:00Z', text: 'Lab sync moved to 10 am Thursday.' }],
};

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

function sidebarProps(overrides: Record<string, unknown> = {}, chatConversations = [
  agentChat(KORDI_SESSION, "Alex's Kordi", 'Lab sync moved to 10 am Thursday.', { unread: 2, metadata: { personalAgent: { agentId: `cloud-agent:${ACCOUNT}` } } }),
  agentChat(RESEARCH_SESSION, 'Research agent', 'Two new papers cite your workshop draft.', { metadata: { personalAgent: { agentId: 'cloud_agent_research' } } }),
  agentChat('session:direct-agent:figure', 'Figure script fix', 'Patched the loader to accept both.'),
]) {
  const spaces = buildParticipantSpaces(chatConversations);
  return baseSidebarProps({
    chatConversations, participantSpaces: spaces, contactParticipantSpaces: [],
    agentParticipantSpaces: filterParticipantSpaces(spaces, '', 'agent'),
    activeConvId: 'session:direct-agent:figure', initialChatChannel: 'agent',
    ...overrides,
  });
}

test('Agent Chats shows the Personal agent entry under New, and personal chats with messages as ordinary rows', () => {
  setPersonalAgentEntries(entries);
  __setDefaultPersonalAgentStatusForTests(watching);
  try {
    const markup = renderToStaticMarkup(createElement(WorkspaceSidebar, sidebarProps() as never));
    const newRow = markup.indexOf('chat-sidebar-new-session"');
    const entry = markup.indexOf('data-testid="personal-agent-entry"');
    assert.ok(newRow >= 0 && entry > newRow, 'the entry follows New');
    assert.match(markup, /Watching 2 sources/);
    assert.doesNotMatch(markup, /No messages yet/);
    assert.doesNotMatch(markup, /data-personal-agent-row=/);
    assert.doesNotMatch(markup, /chat-project-section-toggle[^>]*>[^<]*<[^>]*>Personal agent/);
    // Sessions with messages are listed with the other chats; Inbox helper has none here.
    assert.match(markup, new RegExp(`data-agent-session-row="${KORDI_SESSION}"`));
    assert.match(markup, new RegExp(`data-agent-session-row="${RESEARCH_SESSION}"`));
    assert.doesNotMatch(markup, new RegExp(`data-agent-session-row="${INBOX_SESSION}"`));
    assert.match(markup, /data-agent-session-row="session:direct-agent:figure"/);
  } finally {
    __setDefaultPersonalAgentStatusForTests(null);
    setPersonalAgentEntries([]);
  }
});

test('an empty personal session is not a chat row', () => {
  setPersonalAgentEntries(entries);
  __setDefaultPersonalAgentStatusForTests(watching);
  try {
    const props = sidebarProps({}, [
      agentChat(KORDI_SESSION, "Alex's Kordi", '', { messages: [], subtitle: '', metadata: { personalAgent: { agentId: `cloud-agent:${ACCOUNT}` } } }),
      agentChat('session:direct-agent:figure', 'Figure script fix', 'Patched the loader to accept both.'),
    ]);
    const markup = renderToStaticMarkup(createElement(WorkspaceSidebar, props as never));
    assert.doesNotMatch(markup, new RegExp(`data-agent-session-row="${KORDI_SESSION}"`));
    assert.doesNotMatch(markup, /No messages yet/);
  } finally {
    __setDefaultPersonalAgentStatusForTests(null);
    setPersonalAgentEntries([]);
  }
});

test('the entry opens the Personal agent page over the chat pane; choosing a chat closes it', async () => {
  setPersonalAgentEntries(entries);
  __setDefaultPersonalAgentStatusForTests(watching);
  const selected: string[] = [];
  try {
    await withJsdomRoot(async (mount) => {
      const props = (activeConvId: string) => sidebarProps({ activeConvId, onSelectChatSession: (id: string) => selected.push(id) }) as never;
      let host = await mount(createElement(WorkspaceSidebar, props('session:direct-agent:figure')));
      const entryButton = () => host.querySelector<HTMLButtonElement>('[data-testid="personal-agent-entry"]')!;
      const active = () => host.querySelector('.app-session-row-active')?.getAttribute('data-agent-session-row') ?? null;
      assert.ok(active(), 'the selected chat is highlighted');
      await act(async () => { entryButton().click(); });
      assert.equal(entryButton().getAttribute('aria-current'), 'page');
      assert.equal(active(), null, 'no chat row is selected under the page');
      // Clicking the chat that was selected closes the page.
      await act(async () => { host.querySelector<HTMLButtonElement>('[data-agent-session-row="session:direct-agent:figure"]')!.click(); });
      assert.equal(entryButton().getAttribute('aria-current'), null);
      assert.deepEqual(selected, ['session:direct-agent:figure']);
      // A selection made elsewhere closes it too.
      await act(async () => { entryButton().click(); });
      host = await mount(createElement(WorkspaceSidebar, props(KORDI_SESSION)));
      assert.equal(entryButton().getAttribute('aria-current'), null);
    });
  } finally {
    __setDefaultPersonalAgentStatusForTests(null);
    setPersonalAgentEntries([]);
  }
});

test('the Personal agent page asks for a connector, then offers the switch and what it watches', async () => {
  try {
    __setDefaultPersonalAgentStatusForTests({ ...watching, connected: false, proactive: false, sources: [] });
    let markup = renderToStaticMarkup(createElement(PersonalAgentPage, {}));
    assert.match(markup, /Add a connector to turn it on\./);
    assert.match(markup, />Connect</);
    assert.match(markup, /role="switch"[^>]*aria-checked="false"[^>]*disabled=""/);
    assert.doesNotMatch(markup, /Watching/);

    __setDefaultPersonalAgentStatusForTests({ ...watching, proactive: false });
    markup = renderToStaticMarkup(createElement(PersonalAgentPage, {}));
    assert.match(markup, />Off</);
    assert.doesNotMatch(markup, /disabled=""/);
    assert.match(markup, /Gmail/);

    __setDefaultPersonalAgentStatusForTests(watching);
    markup = renderToStaticMarkup(createElement(PersonalAgentPage, {}));
    assert.match(markup, /aria-checked="true"/);
    assert.match(markup, /Watching 2 sources/);
    assert.match(markup, /Lab sync moved to 10 am Thursday\./);
    assert.match(markup, /Manage connectors/);
    assert.doesNotMatch(markup, /PERSONAL AGENT|WATCHING|RECENT/);

    // The switch turns it off.
    await withJsdomRoot(async (mount) => {
      const host = await mount(createElement(PersonalAgentPage, {}));
      await act(async () => { host.querySelector<HTMLButtonElement>('[role="switch"]')!.click(); });
      assert.equal(host.querySelector('[role="switch"]')!.getAttribute('aria-checked'), 'false');
    });
  } finally {
    __setDefaultPersonalAgentStatusForTests(null);
  }
});

function headerConversation() {
  return agentChat(RESEARCH_SESSION, 'Two new papers', 'Two new papers cite your workshop draft.', { metadata: { personalAgent: { agentId: 'cloud_agent_research' } } });
}

test('a personal session header shows Online after the name without an avatar, and cannot be renamed', () => {
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
    assert.match(markup, /<\/h2><span class="app-personal-agent-header-status"[^>]*>.*Online<\/span>/);
    assert.doesNotMatch(markup, /app-presence-light/);
    assert.doesNotMatch(markup, /app-identity-avatar|<img/);
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
  assert.deepEqual(sessions, [{ agentId: 'cloud_agent_research', conversationId: 'conv-1', sessionId: RESEARCH_SESSION, proactive: true }]);
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

test('a personal session in the list keeps the restricted menu, from the list or, before it loads, its marker', async () => {
  for (const [listed, actions] of [[entries, ['Mark as read', 'Mute', 'Agent settings']], [[], ['Mark as read', 'Mute']]] as const) {
    setPersonalAgentEntries(listed);
    try {
      await withJsdomRoot(async (mount) => {
        const host = await mount(createElement(WorkspaceSidebar, sidebarProps({ onOpenAgentSettings: () => undefined }) as never));
        await act(async () => {
          host.querySelector(`[data-agent-session-row="${KORDI_SESSION}"]`)!
            .dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 80 }));
        });
        assert.deepEqual([...document.querySelectorAll('[data-session-context-action]')].map((item) => item.textContent?.trim()), actions);
      });
    } finally {
      setPersonalAgentEntries([]);
    }
  }
});

test('an agent whose Proactive is off is an ordinary chat with the normal menu', async () => {
  // The loaded list no longer has Research agent; its session still carries the marker for a moment.
  setPersonalAgentEntries(entries.filter((entry) => entry.agentId !== 'cloud_agent_research'), true);
  try {
    await withJsdomRoot(async (mount) => {
      const host = await mount(createElement(WorkspaceSidebar, sidebarProps() as never));
      const row = host.querySelector<HTMLButtonElement>(`[data-agent-session-row="${RESEARCH_SESSION}"]`);
      assert.ok(row, 'the old session is listed with the other chats');
      await act(async () => {
        row.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 80 }));
      });
      const menu = document.body.textContent ?? '';
      for (const action of ['Rename', 'Pin', 'Archive', 'Delete chat']) assert.ok(menu.includes(action), action);
      assert.equal(document.querySelector('[data-session-context-action="agent-settings"]'), null);
    });
  } finally {
    setPersonalAgentEntries([], false);
  }
});
