import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { activeConversationForSelection, useWorkspaceViewModels } from '../src/app/useWorkspaceViewModels';
import { createCanonicalSessionReadModel } from '../src/features/canonical/sessionReadModel';
import { isCanonicalCloudSessionId } from '../src/features/canonical/sessionResolver';
import { EMPTY_CHAT_SELECTION_ID } from '../src/features/chat/draftSessions';

test('workspace active conversation resolves canonical Cloud direct session ids to the Cloud bridge conversation', () => {
  const localConversation = {
    id: 'local-newer',
    canonicalSessionId: 'local-newer',
    name: 'Local newer',
    type: 'owned-agent' as const,
    subtitle: 'Local fallback should not win',
    unread: 0,
    collaborationSources: ['Local'],
    trust: 'Owned',
    directness: 'Direct chat',
    participants: ['Me', 'My Kordi'],
    messages: [{ role: 'owned-agent' as const, text: 'wrong local conversation', time: '10:02' }],
  };
  const cloudConversation = {
    id: 'bridge:cloud:acct_e933bef06cc0499c8287f4fd43205eab:person',
    canonicalSessionId: 'session:direct-person:acct_ab28e22a7e904f00bbe5d76eff13b495:acct_e933bef06cc0499c8287f4fd43205eab',
    name: 'Cloud peer',
    type: 'person' as const,
    subtitle: 'Cloud direct chat',
    unread: 0,
    collaborationSources: ['Cloud'],
    trust: 'Bridge',
    directness: 'Direct person chat',
    participants: ['Me', 'Cloud peer'],
    messages: [{ role: 'user' as const, isOwnMessage: true, text: 'hi', time: '10:01' }],
    collaborationTarget: { hostId: 'cloud', nodeId: 'acct_e933bef06cc0499c8287f4fd43205eab', runtime: 'person' },
  };

  const selected = activeConversationForSelection(
    'session:direct-person:acct_ab28e22a7e904f00bbe5d76eff13b495:acct_e933bef06cc0499c8287f4fd43205eab',
    [localConversation, cloudConversation],
    { isNativeShell: true, nativeChatPlaceholder: localConversation },
  );

  assert.equal(selected.id, cloudConversation.id);
  assert.equal(selected.messages[0]?.text, 'hi');
});

test('startup stays neutral until a session is explicitly selected', () => {
  const blankShell = {
    id: 'session:self-agent:blank',
    canonicalSessionId: 'session:self-agent:blank',
    name: 'New chat',
    type: 'owned-agent' as const,
    subtitle: '',
    unread: 0,
    collaborationSources: ['Local'],
    trust: 'Owned',
    directness: 'Draft',
    participants: ['Me', 'My Kordi'],
    messages: [],
  };
  const existingChat = {
    ...blankShell,
    id: 'session:self-agent:existing',
    canonicalSessionId: 'session:self-agent:existing',
    name: 'Release plan',
    directness: 'Agent chat',
    messages: [{ role: 'user' as const, text: 'Review the plan', time: '10:00' }],
  };
  const emptyState = {
    ...blankShell,
    id: EMPTY_CHAT_SELECTION_ID,
    canonicalSessionId: undefined,
    name: 'Chats',
    directness: '',
  };

  assert.equal(activeConversationForSelection(
    '',
    [blankShell, existingChat],
    {
      isNativeShell: true,
      nativeChatPlaceholder: emptyState,
      fallbackConversation: existingChat,
    },
  ).id, EMPTY_CHAT_SELECTION_ID);
  assert.equal(activeConversationForSelection(
    blankShell.id,
    [blankShell, existingChat],
    {
      isNativeShell: true,
      nativeChatPlaceholder: emptyState,
      fallbackConversation: existingChat,
    },
  ).id, blankShell.id);
});

test('workspace uses a neutral empty selection when the runtime contains only a blank shell', () => {
  let viewModels: ReturnType<typeof useWorkspaceViewModels> | null = null;
  function Probe() {
    viewModels = useWorkspaceViewModels({
      isNativeShell: true,
      isDesktopChatLoading: false,
      desktopChatState: {
        activeSessionId: 'session:self-agent:blank',
        sessions: [{ id: 'session:self-agent:blank', title: 'New chat', subtitle: '', updatedAtLabel: 'Draft', messageCount: 0, draft: true }],
        activeSession: { id: 'session:self-agent:blank', title: 'New chat', subtitle: '', updatedAtLabel: 'Draft', messageCount: 0, draft: true, messages: [], project: null, reflectionLessonArtifacts: [] },
        localAgent: { label: 'My Kordi' },
      } as never,
      desktopCollaborationState: null,
      canonicalSessionState: null,
      hiddenSessionIds: new Set(),
      projectWorkspaces: [],
      projectSelectedSessionIds: {},
      activeNav: 'chats',
      activeConvId: '',
      activeProjectId: '',
      activeProjectSessionId: 'draft:project-chat',
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
      cloudSessionActivity: { tasksBySessionId: {}, artifactsBySessionId: {} },
    });
    return null;
  }

  renderToStaticMarkup(createElement(Probe));

  assert.equal(
    viewModels?.activeConv.id,
    EMPTY_CHAT_SELECTION_ID,
    JSON.stringify(viewModels?.chatConversations),
  );
  assert.deepEqual(
    viewModels?.agentParticipantSpaces.flatMap((space) => space.sessions),
    [],
  );
});

test('workspace active conversation does not fall back to a local UUID while a Cloud contact opens', () => {
  let viewModels: ReturnType<typeof useWorkspaceViewModels> | null = null;
  function Probe() {
    viewModels = useWorkspaceViewModels({
      isNativeShell: true,
      isDesktopChatLoading: false,
      desktopChatState: {
        activeSessionId: 'local-session-1',
        sessions: [{ id: 'local-session-1', title: 'Local accidental session', subtitle: '', updatedAtLabel: '19:06', messageCount: 1, draft: false }],
        activeSession: { id: 'local-session-1', title: 'Local accidental session', subtitle: '', updatedAtLabel: '19:06', messageCount: 1, draft: false, messages: [], project: null, reflectionLessonArtifacts: [] },
        localAgent: { label: 'My Kordi' },
      } as never,
      desktopCollaborationState: null,
      canonicalSessionState: null,
      hiddenSessionIds: new Set(),
      projectWorkspaces: [],
      projectSelectedSessionIds: {},
      activeNav: 'chats',
      activeConvId: 'bridge:cloud:acct_peer:person',
      activeProjectId: '',
      activeProjectSessionId: 'draft:project-chat',
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
      cloudSessionActivity: { tasksBySessionId: {}, artifactsBySessionId: {} },
    });
    return null;
  }

  renderToStaticMarkup(createElement(Probe));

  assert.equal(viewModels?.activeConv.id, 'bridge:cloud:acct_peer:person');
  assert.equal(viewModels?.activeConv.collaborationTarget?.hostId, 'cloud');
});

test('workspace view model exposes side-created agent sessions with their live turn for agent session panels', () => {
  let viewModels: ReturnType<typeof useWorkspaceViewModels> | null = null;
  const sideTurn = {
    id: 'turn-side-1',
    sessionId: 'side-agent-session',
    prompt: 'inspect this',
    status: 'running',
    message: 'Working…',
    assistantText: '',
    thinkingText: 'Looking at the referenced chat',
    tools: [{ id: 'tool-read', name: 'read_session', status: 'running', arguments: '{}', liveOutput: '', resultText: null, detail: null, isError: false }],
    completed: false,
    succeeded: false,
  };

  function Probe() {
    viewModels = useWorkspaceViewModels({
      isNativeShell: true,
      isDesktopChatLoading: false,
      desktopChatState: {
        activeSessionId: 'side-agent-session',
        sessions: [{ id: 'main-agent-session', title: 'Main agent session', subtitle: '', updatedAtLabel: '19:06', messageCount: 1, draft: false }],
        activeSession: { id: 'side-agent-session', title: 'Side agent session', subtitle: '', updatedAtLabel: '19:07', messageCount: 0, draft: false, messages: [], project: null, reflectionLessonArtifacts: [] },
        localAgent: { label: 'My Kordi' },
      } as never,
      desktopCollaborationState: null,
      canonicalSessionState: null,
      hiddenSessionIds: new Set(),
      projectWorkspaces: [],
      projectSelectedSessionIds: {},
      activeNav: 'chats',
      activeConvId: 'main-agent-session',
      activeProjectId: '',
      activeProjectSessionId: 'draft:project-chat',
      chatSearch: '',
      projectSearch: '',
      contactSearch: '',
      activeContactId: '',
      activeAgentId: '',
      cachedChatSessionMessages: {},
      cachedProjectSessionMessages: {},
      localSessionUnreadCounts: {},
      desktopLiveTurnsBySession: { 'side-agent-session': sideTurn },
      mapDesktopMessages: () => [],
      cloudSessionActivity: { tasksBySessionId: {}, artifactsBySessionId: {} },
    });
    return null;
  }

  renderToStaticMarkup(createElement(Probe));

  const sideConversation = viewModels?.chatConversations.find((conversation) => conversation.id === 'side-agent-session');
  assert.equal(sideConversation?.name, 'Side agent session');
  assert.equal(sideConversation?.previewLiveTurn?.id, 'turn-side-1');
  assert.equal(viewModels?.agentParticipantSpaces.some((space) => space.sessions.some((session) => session.id === 'side-agent-session')), true);
});

test('canonical direct person conversations use contact name and latest-message subtitle', () => {
  const readModel = createCanonicalSessionReadModel({
    storagePath: '/tmp/canonical.sqlite3',
    profile: {
      id: 'profile:me',
      displayName: 'Me',
      humanIdentityId: 'human:me',
      activeAgentIdentityId: null,
      storageRoot: '/tmp',
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    identities: [
      { id: 'human:me', kind: 'human', displayName: 'Me', source: 'local', avatarKey: 'me', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'human:bob', kind: 'human', displayName: 'Kordi User 2', source: 'bridge', humanId: 'kh_bob', sourceIdentityId: 'kd_bob', avatarKey: 'bob', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [{
      id: 'session:bridge:humans:bob',
      kind: 'direct-person',
      title: 'how is weather in jeddah',
      status: 'active',
      createdByIdentityId: 'human:me',
      primaryIdentityId: 'human:bob',
      relationshipIdentityId: 'human:bob',
      metadata: { source: 'bridge-session-thread', sourceHostId: 'host-1', peerNodeId: 'kd_bob', peerRuntime: 'person' },
      createdAtMs: 1,
      updatedAtMs: 3,
      lastMessageAtMs: 3,
    }],
    participants: [
      { sessionId: 'session:bridge:humans:bob', identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId: 'session:bridge:humans:bob', identityId: 'human:bob', role: 'delegate', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg:first', sessionId: 'session:bridge:humans:bob', senderIdentityId: 'human:bob', senderRole: 'person', messageKind: 'text', contentText: 'how is weather in jeddah', content: { sender: 'Kordi User 2', timeLabel: '00:29' }, status: 'sent', sequenceNum: 1, createdAtMs: 2, updatedAtMs: 2, contentHash: null, sourceTransport: 'desktop-bridge-parent', sourceEventId: 'first' },
      { id: 'msg:latest', sessionId: 'session:bridge:humans:bob', senderIdentityId: 'human:bob', senderRole: 'person', messageKind: 'text', contentText: 'Jeddah is mostly clear now', content: { sender: 'Kordi User 2', timeLabel: '00:31' }, status: 'sent', sequenceNum: 2, createdAtMs: 3, updatedAtMs: 3, contentHash: null, sourceTransport: 'desktop-bridge-parent', sourceEventId: 'latest' },
    ],
    delegatedExchanges: [],
    contextSnapshots: [],
    presence: [],
  } as never);

  const conversations = readModel?.buildChatConversations([], (messages, fallback) => messages[messages.length - 1]?.text ?? fallback ?? '') ?? [];
  const conversation = conversations.find((item) => item.canonicalSessionId === 'session:bridge:humans:bob');

  assert.equal(conversation?.name, 'Kordi User 2');
  assert.equal(conversation?.subtitle, 'Jeddah is mostly clear now');
});

test('workspace view model exposes participant spaces alongside flat chat conversations', () => {
  let viewModels: ReturnType<typeof useWorkspaceViewModels> | null = null;
  function Probe() {
    viewModels = useWorkspaceViewModels({
      isNativeShell: false,
      isDesktopChatLoading: false,
      desktopChatState: null,
      desktopCollaborationState: null,
      canonicalSessionState: null,
      hiddenSessionIds: new Set(),
      projectWorkspaces: [{
        id: 'project:test',
        name: 'Test project',
        summary: 'Fixture project',
        bridge: 'Local',
        scope: '/tmp/kordi-test',
        status: 'Local',
        people: [],
        agents: [],
        pendingInvites: [],
        artifacts: 0,
        tasks: 0,
        sessions: [],
      }],
      projectSelectedSessionIds: {},
      activeNav: 'chats',
      activeConvId: 'c1',
      activeProjectId: '',
      activeProjectSessionId: '',
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
    return null;
  }

  renderToStaticMarkup(createElement(Probe));

  assert.ok(viewModels?.participantSpaces.length);
  assert.ok(viewModels?.participantSpaces[0]?.sessions.length);
  const totalChannelSpaces = (viewModels?.contactParticipantSpaces.length ?? 0) + (viewModels?.agentParticipantSpaces.length ?? 0);
  assert.equal(totalChannelSpaces, viewModels?.participantSpaces.length);
});

test('canonical cloud session id helper identifies direct-person and group cloud chat ids', () => {
  assert.equal(isCanonicalCloudSessionId('session:direct-person:acct_me:acct_peer'), true);
  assert.equal(isCanonicalCloudSessionId('session:group:cloud-child'), true);
  assert.equal(isCanonicalCloudSessionId('session:bridge:humans:bob'), false);
  assert.equal(isCanonicalCloudSessionId('local-agent-session'), false);
});

test('workspace view model treats canonical Cloud direct and group sessions as non-local conversations', () => {
  const canonicalState = {
    storagePath: '/tmp/canonical.sqlite3',
    profile: {
      id: 'profile:me',
      displayName: 'Me',
      humanIdentityId: 'human:me',
      activeAgentIdentityId: null,
      storageRoot: '/tmp',
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    identities: [
      { id: 'human:me', kind: 'human', displayName: 'Me', source: 'local', avatarKey: 'me', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'human:peer', kind: 'human', displayName: 'Peer', source: 'imported', avatarKey: 'peer', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [{
      id: 'session:direct-person:acct_me:acct_peer',
      kind: 'direct-person',
      title: 'Cloud private chat',
      status: 'active',
      createdByIdentityId: 'human:me',
      primaryIdentityId: 'human:peer',
      relationshipIdentityId: 'human:peer',
      metadata: { source: 'cloud-direct' },
      createdAtMs: 1,
      updatedAtMs: 2,
      lastMessageAtMs: 2,
    }],
    participants: [
      { sessionId: 'session:direct-person:acct_me:acct_peer', identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId: 'session:direct-person:acct_me:acct_peer', identityId: 'human:peer', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg:peer', sessionId: 'session:direct-person:acct_me:acct_peer', senderIdentityId: 'human:peer', senderRole: 'person', messageKind: 'text', contentText: 'Cloud hello', content: { sender: 'Peer', timeLabel: '10:00' }, status: 'sent', sequenceNum: 1, createdAtMs: 2, updatedAtMs: 2, contentHash: null, sourceTransport: 'cloud-direct', sourceEventId: 'cloud_1' },
    ],
    delegatedExchanges: [],
    contextSnapshots: [],
    presence: [],
  };

  let viewModels: ReturnType<typeof useWorkspaceViewModels> | null = null;
  function Probe() {
    viewModels = useWorkspaceViewModels({
      isNativeShell: true,
      isDesktopChatLoading: false,
      desktopChatState: null,
      desktopCollaborationState: null,
      canonicalSessionState: canonicalState as never,
      hiddenSessionIds: new Set(),
      projectWorkspaces: [],
      projectSelectedSessionIds: {},
      activeNav: 'chats',
      activeConvId: 'session:direct-person:acct_me:acct_peer',
      activeProjectId: '',
      activeProjectSessionId: 'draft:project-chat',
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
    return null;
  }

  renderToStaticMarkup(createElement(Probe));

  assert.equal(viewModels?.activeConversationUsesCollaboration, true);
});
