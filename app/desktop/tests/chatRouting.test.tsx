import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { stripDerivedCloudUnreadCounts } from '../src/app/useKordiAppModelHelpers';
import { visibleLocalSessionIdForActivity } from '../src/app/useKordiDesktopActivity';
import { activeConversationForSelection, applyCanonicalHydrationPlaceholder, collaborationChatConversationIsVisible, pendingCloudCollaborationConversationForActiveId, useWorkspaceViewModels } from '../src/app/useWorkspaceViewModels';
import { shouldUseCanonicalMessages } from '../src/features/canonical/readModel/conversationMapping';
import { mapCanonicalMessage } from '../src/features/canonical/readModel/messageMapping';
import { restoredSelfAgentContextMessages } from '../src/features/chat/messageActions/chatMessages';
import { createCanonicalSessionReadModel, mergeCanonicalHistoryIntoRuntime } from '../src/features/canonical/sessionReadModel';
import { isCanonicalCloudSessionId } from '../src/features/canonical/sessionResolver';
import { buildParticipantSpaces } from '../src/features/chat/participantSpaces';
import type { CanonicalSessionState, Message } from '../src/kordi-app/types';

test('canonical hydration strips persisted derived cloud unread counts', () => {
  const state: CanonicalSessionState = {
    storagePath: '/tmp/canonical.sqlite3',
    profile: {
      id: 'profile:test',
      displayName: 'Me',
      humanIdentityId: 'human:test',
      activeAgentIdentityId: 'agent:test',
      storageRoot: '/tmp',
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    identities: [],
    sessions: [{
      id: 'session:self-agent:test',
      kind: 'self-agent',
      title: 'Self chat',
      status: 'active',
      createdByIdentityId: 'human:test',
      metadata: { cloudUnreadCount: 82, keep: 'value' },
      createdAtMs: 1,
      updatedAtMs: 1,
      lastMessageAtMs: 1,
    }],
    participants: [],
    messages: [],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  };

  const scrubbed = stripDerivedCloudUnreadCounts(state);
  const metadata = scrubbed?.sessions[0]?.metadata as Record<string, unknown> | undefined;
  assert.equal(metadata?.cloudUnreadCount, undefined);
  assert.equal(metadata?.keep, 'value');
});

test('pending Cloud contact selection keeps active conversation on Cloud instead of falling back to local session', () => {
  const conversation = pendingCloudCollaborationConversationForActiveId('bridge:cloud:acct_peer:person');

  assert.equal(conversation?.id, 'bridge:cloud:acct_peer:person');
  assert.equal(conversation?.collaborationTarget?.hostId, 'cloud');
  assert.equal(conversation?.collaborationTarget?.nodeId, 'acct_peer');
  assert.equal(conversation?.collaborationSources.includes('Cloud'), true);
});

test('workspace active conversation resolves Cloud self-agent bridge session ids to restored canonical sessions', () => {
  const localConversation = {
    id: '109fcf23-654c-41a7-bd73-8156b0b89703',
    canonicalSessionId: '109fcf23-654c-41a7-bd73-8156b0b89703',
    name: 'Thuwal weather today',
    type: 'owned-agent' as const,
    subtitle: 'Local restored self-agent chat',
    unread: 0,
    collaborationSources: ['Local'],
    trust: 'Owned',
    directness: 'Direct chat',
    participants: ['Me', 'My Kordi'],
    messages: [{ role: 'user' as const, isOwnMessage: true, text: 'Can anyone relate?', time: '11:27' }],
  };
  const cloudBridgeSelection = 'bridge:cloud:acct_me:session:109fcf23-654c-41a7-bd73-8156b0b89703';

  const selected = activeConversationForSelection(
    cloudBridgeSelection,
    [localConversation],
    { isNativeShell: true, nativeChatPlaceholder: localConversation },
  );

  assert.equal(selected.id, localConversation.id);
  assert.equal(selected.messages[0]?.text, 'Can anyone relate?');
});

test('workspace active conversation keeps selected canonical Cloud session in loading state while hydration catches up', () => {
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
    messages: [{ role: 'owned-agent' as const, text: 'wrong local fallback', time: '10:02' }],
  };

  const selected = activeConversationForSelection(
    'session:group:clicked-before-hydration',
    [localConversation],
    { isNativeShell: true, nativeChatPlaceholder: localConversation },
  );

  assert.equal(selected.id, 'session:group:clicked-before-hydration');
  assert.equal(selected.canonicalSessionId, 'session:group:clicked-before-hydration');
  assert.equal(selected.unread, 0);
  assert.equal(selected.messages.length > 0, true);
  assert.match(selected.messages[0]?.text ?? '', /loading|opening/i);
  assert.notEqual(selected.messages[0]?.text, 'wrong local fallback');
});

test('workspace active conversation shows loading copy for an empty selected canonical Cloud shell', () => {
  const emptyCloudShell = {
    id: 'session:group:main',
    canonicalSessionId: 'session:group:main',
    name: 'main',
    type: 'owned-agent' as const,
    subtitle: '',
    unread: 0,
    collaborationSources: ['Cloud'],
    trust: 'Bridge',
    directness: 'Group chat',
    participants: ['Me', 'Alice'],
    messages: [],
  };

  const selected = activeConversationForSelection(
    'session:group:main',
    [emptyCloudShell],
    { isNativeShell: true, nativeChatPlaceholder: emptyCloudShell },
  );

  assert.equal(selected.id, 'session:group:main');
  assert.equal(selected.name, 'main');
  assert.equal(selected.messages.length > 0, true);
  assert.match(selected.messages[0]?.text ?? '', /loading|opening/i);
});

test('workspace active conversation keeps a catalog-confirmed empty group session blank while hydration runs', () => {
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
    messages: [{ role: 'owned-agent' as const, text: 'wrong local history', time: '10:02' }],
  };
  const emptyGroupSession = {
    id: 'session:group:new-chat',
    canonicalSessionId: 'session:group:new-chat',
    canonicalMessageCount: 0,
    name: 'New chat',
    type: 'owned-agent' as const,
    subtitle: '',
    unread: 0,
    collaborationSources: ['Cloud'],
    trust: 'Bridge',
    directness: 'Group chat',
    participants: ['Me', 'Alice', 'Bob'],
    messages: [],
  };

  const selected = activeConversationForSelection(
    emptyGroupSession.id,
    [localConversation, emptyGroupSession],
    { isNativeShell: true, nativeChatPlaceholder: localConversation },
  );
  const hydrated = applyCanonicalHydrationPlaceholder(selected, 'loading');

  assert.equal(hydrated.id, emptyGroupSession.id);
  assert.equal(hydrated.subtitle, '');
  assert.deepEqual(hydrated.messages, []);
});

test('workspace keeps a desktop runtime transcript visible while canonical hydration is loading', () => {
  let viewModels: ReturnType<typeof useWorkspaceViewModels> | null = null;

  function Probe() {
    viewModels = useWorkspaceViewModels({
      isNativeShell: true,
      isDesktopChatLoading: false,
      desktopChatState: {
        activeSessionId: 'local-runtime-session',
        sessions: [{
          id: 'local-runtime-session',
          title: 'Runtime chat',
          subtitle: 'Runtime transcript',
          updatedAtLabel: '14:53',
          messageCount: 2,
          draft: false,
        }],
        activeSession: {
          id: 'local-runtime-session',
          cwd: '/tmp/kordi',
          title: 'Runtime chat',
          subtitle: 'Runtime transcript',
          updatedAtLabel: '14:53',
          messageCount: 2,
          draft: false,
          project: null,
          reflectionLessonArtifacts: [],
          messages: [
            { role: 'user', text: 'hihi', timeLabel: '14:52' },
            { role: 'assistant', text: 'Hi! How can I help?', timeLabel: '14:53' },
          ],
        },
        localAgent: { label: 'My Kordi' },
      } as never,
      desktopCollaborationState: null,
      canonicalSessionState: {
        storagePath: '/tmp/canonical.sqlite3',
        profile: {
          id: 'profile:me',
          displayName: 'Me',
          humanIdentityId: 'human:me',
          activeAgentIdentityId: 'agent:me',
          storageRoot: '/tmp',
          createdAtMs: 1,
          updatedAtMs: 1,
        },
        identities: [
          { id: 'human:me', kind: 'human', displayName: 'Me', source: 'local', createdAtMs: 1, updatedAtMs: 1 },
          { id: 'agent:me', kind: 'agent', displayName: 'My Kordi', source: 'local', ownerIdentityId: 'human:me', createdAtMs: 1, updatedAtMs: 1 },
        ],
        sessions: [{
          id: 'local-runtime-session',
          kind: 'self-agent',
          title: 'Runtime chat',
          status: 'active',
          createdByIdentityId: 'human:me',
          primaryIdentityId: 'agent:me',
          createdAtMs: 1,
          updatedAtMs: 2,
          lastMessageAtMs: 2,
        }],
        participants: [
          { sessionId: 'local-runtime-session', identityId: 'human:me', role: 'self', state: 'active', addedAtMs: 1 },
          { sessionId: 'local-runtime-session', identityId: 'agent:me', role: 'delegate', state: 'active', addedAtMs: 1 },
        ],
        messages: [
          {
            id: 'msg:canonical:old-user',
            sessionId: 'local-runtime-session',
            senderIdentityId: 'human:me',
            senderRole: 'user',
            messageKind: 'text',
            contentText: 'older question',
            content: { sender: 'Me', timeLabel: '14:50' },
            status: 'sent',
            sequenceNum: 1,
            createdAtMs: 1,
            updatedAtMs: 1,
            contentHash: null,
            sourceTransport: 'cloud-self-agent',
            sourceEventId: 'old-user',
          },
          {
            id: 'msg:canonical:old-agent',
            sessionId: 'local-runtime-session',
            senderIdentityId: 'agent:me',
            senderRole: 'owned-agent',
            messageKind: 'agent-turn',
            contentText: 'older answer',
            content: { sender: 'My Kordi', timeLabel: '14:51', deliveryState: 'complete' },
            status: 'complete',
            sequenceNum: 2,
            createdAtMs: 2,
            updatedAtMs: 2,
            contentHash: null,
            sourceTransport: 'cloud-self-agent',
            sourceEventId: 'old-agent',
          },
          {
            id: 'msg:forward:display-only',
            sessionId: 'local-runtime-session',
            senderIdentityId: 'human:me',
            senderRole: 'user',
            messageKind: 'text',
            contentText: '@MyKordi forwarded context',
            content: {
              sender: 'Me',
              timeLabel: '14:51',
              messageAction: {
                schemaVersion: 1,
                kind: 'forward',
                source: {
                  sourceSessionId: 'session:source',
                  sourceMessageId: 'msg:source',
                  senderLabel: 'Me',
                  textPreview: '@MyKordi forwarded context',
                  attachmentCount: 0,
                },
              },
            },
            status: 'sent',
            sequenceNum: 3,
            createdAtMs: 3,
            updatedAtMs: 3,
            contentHash: null,
            sourceTransport: 'desktop-forward',
            sourceEventId: 'desktop-forward:display-only',
          },
          {
            id: 'msg:ui:stale-sending',
            sessionId: 'local-runtime-session',
            senderIdentityId: 'human:me',
            senderRole: 'user',
            messageKind: 'text',
            contentText: 'hihi',
            content: { sender: 'Me', timeLabel: '14:52', deliveryState: 'sending' },
            status: 'sending',
            sequenceNum: 4,
            createdAtMs: 4,
            updatedAtMs: 4,
            contentHash: null,
            sourceTransport: 'desktop-chat-ui',
            sourceEventId: 'desktop-chat-ui:local-runtime-session:3',
          },
          {
            id: 'msg:runtime:assistant-response',
            sessionId: 'local-runtime-session',
            senderIdentityId: 'agent:me',
            senderRole: 'owned-agent',
            messageKind: 'agent-turn',
            contentText: 'Hi! How can I help?',
            content: { sender: 'My Kordi', timeLabel: '14:53', deliveryState: 'complete' },
            status: 'complete',
            sequenceNum: 5,
            createdAtMs: 5,
            updatedAtMs: 5,
            contentHash: null,
            sourceTransport: 'desktop-chat',
            sourceEventId: 'desktop-chat:local-runtime-session:4',
          },
          {
            id: 'msg:ui:no-provider-user',
            sessionId: 'local-runtime-session',
            senderIdentityId: 'human:me',
            senderRole: 'user',
            messageKind: 'text',
            contentText: 'offline hi',
            content: { sender: 'Me', timeLabel: '14:54', deliveryState: 'sent' },
            status: 'sent',
            sequenceNum: 6,
            createdAtMs: 6,
            updatedAtMs: 6,
            contentHash: null,
            sourceTransport: 'desktop-chat-ui',
            sourceEventId: 'desktop-chat-ui:local-runtime-session:5',
          },
          {
            id: 'msg:ui:no-provider-error',
            sessionId: 'local-runtime-session',
            senderIdentityId: 'agent:me',
            senderRole: 'owned-agent',
            messageKind: 'agent-turn',
            contentText: '',
            content: {
              sender: 'My Kordi',
              timeLabel: '14:54',
              deliveryState: 'failed',
              error: 'No provider configured yet.',
              replyToMessageId: 'msg:ui:no-provider-user',
            },
            parentMessageId: 'msg:ui:no-provider-user',
            status: 'failed',
            sequenceNum: 7,
            createdAtMs: 7,
            updatedAtMs: 7,
            contentHash: null,
            sourceTransport: 'desktop-chat-ui',
            sourceEventId: 'desktop-chat-ui:local-runtime-session:6',
          },
        ],
        delegatedExchanges: [],
        presence: [],
        contextSnapshots: [],
      } as never,
      canonicalHydrationBySessionId: { 'local-runtime-session': 'loading' },
      hiddenSessionIds: new Set(),
      projectWorkspaces: [],
      projectSelectedSessionIds: {},
      activeNav: 'chats',
      activeConvId: 'local-runtime-session',
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
      mapDesktopMessages: (_sessionId, messages) => messages.map((message) => ({
        role: message.role === 'assistant' ? 'owned-agent' : 'user',
        text: message.text,
        time: message.timeLabel,
      })),
    });
    return null;
  }

  renderToStaticMarkup(createElement(Probe));

  assert.equal(viewModels?.activeConv.desktopRuntimeBacked, true);
  assert.equal(viewModels?.activeConv.desktopRuntimeTranscriptLoaded, true);
  assert.deepEqual(viewModels?.activeConv.messages.map((message) => message.turn?.assistantText || message.turn?.error || message.text), [
    'older question',
    'older answer',
    '@MyKordi forwarded context',
    'hihi',
    'Hi! How can I help?',
    'offline hi',
    'No provider configured yet.',
  ]);
  assert.notEqual(viewModels?.activeConv.subtitle, 'Loading chat history…');
});

test('workspace sorts a newly active local session ahead of older canonical sessions', () => {
  const activeSessionId = 'local-newly-active';
  const olderSessionId = 'local-older-canonical';
  let viewModels: ReturnType<typeof useWorkspaceViewModels> | null = null;

  function Probe() {
    viewModels = useWorkspaceViewModels({
      isNativeShell: true,
      isDesktopChatLoading: false,
      desktopChatState: {
        cwd: '/tmp/kordi',
        activeSessionId,
        sessions: [{
          id: olderSessionId,
          title: 'Older session',
          subtitle: 'Older activity',
          updatedAtLabel: 'Jul 15',
          updatedAtMs: 1_000,
          messageCount: 1,
          draft: false,
        }],
        activeSession: {
          id: activeSessionId,
          cwd: '/tmp/kordi',
          title: 'Newly active session',
          subtitle: 'Just sent',
          provider: 'openai',
          providerLabel: 'OpenAI',
          model: 'gpt-test',
          modelLabel: 'GPT Test',
          thinking: 'medium',
          thinkingLabel: 'Medium',
          thinkingLevels: ['medium'],
          updatedAtLabel: '15:59',
          updatedAtMs: 9_000,
          messageCount: 1,
          draft: false,
          contextWindowText: '',
          contextWindowStatus: {
            contextWindow: 0,
            usedTokens: null,
            usedPercent: null,
            autoCompaction: false,
          },
          project: null,
          reflectionLessonArtifacts: [],
          messages: [{
            role: 'user',
            text: 'new activity',
            timeLabel: '15:59',
            timestampMs: 9_000,
          }],
        },
        localAgent: {
          label: 'My Kordi',
          systemPrompt: '',
          loadedSkills: [],
          loadedTools: [],
          loadedPlugins: [],
          identityFiles: [],
          defaultProvider: 'openai',
          defaultModel: 'gpt-test',
          workspaceRoot: '/tmp/kordi',
          lastActivities: [],
        },
        projects: [],
        modelOptions: [],
        slashCommands: [],
      } as never,
      desktopBridgeState: null,
      canonicalSessionState: {
        storagePath: '/tmp/canonical.sqlite3',
        profile: {
          id: 'profile:me',
          displayName: 'Me',
          humanIdentityId: 'human:me',
          activeAgentIdentityId: 'agent:me',
          storageRoot: '/tmp',
          createdAtMs: 1,
          updatedAtMs: 1,
        },
        identities: [
          { id: 'human:me', kind: 'human', displayName: 'Me', source: 'local', avatarKey: 'me', createdAtMs: 1, updatedAtMs: 1 },
          { id: 'agent:me', kind: 'agent', displayName: 'My Kordi', source: 'local', ownerIdentityId: 'human:me', avatarKey: 'agent-me', createdAtMs: 1, updatedAtMs: 1 },
        ],
        sessions: [{
          id: olderSessionId,
          kind: 'self-agent',
          title: 'Older session',
          status: 'active',
          createdByIdentityId: 'human:me',
          primaryIdentityId: 'agent:me',
          relationshipIdentityId: 'agent:me',
          metadata: { source: 'desktop-chat' },
          createdAtMs: 500,
          updatedAtMs: 1_000,
          lastMessageAtMs: 1_000,
        }],
        participants: [
          { sessionId: olderSessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 500 },
          { sessionId: olderSessionId, identityId: 'agent:me', role: 'delegate', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 500 },
        ],
        messages: [],
        delegatedExchanges: [],
        contextSnapshots: [],
        presence: [],
      },
      hiddenSessionIds: new Set(),
      projectWorkspaces: [],
      projectSelectedSessionIds: {},
      activeNav: 'chats',
      activeConvId: activeSessionId,
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
      mapDesktopMessages: (_sessionId, messages) => messages.map((message) => ({
        role: message.role === 'assistant' ? 'owned-agent' : 'user',
        text: message.text,
        time: message.timeLabel,
      })),
    });
    return null;
  }

  renderToStaticMarkup(createElement(Probe));

  assert.deepEqual(
    viewModels?.chatConversations.slice(0, 2).map((conversation) => conversation.id),
    [activeSessionId, olderSessionId],
  );
  assert.equal(viewModels?.activeConv.id, activeSessionId);
});

test('runtime transcript reconciliation renders one failure when canonical and desktop rows encode it differently', () => {
  const failure = 'ChatGPT OAuth credentials are not usable. Sign in to ChatGPT again, or switch this provider to an OpenAI API key.';
  const canonicalFailure: Message = {
    id: 'canonical-provider-failure',
    role: 'owned-agent',
    text: '',
    time: '17:30',
    turn: {
      id: 'canonical-turn:provider-failure',
      sessionId: 'session:test',
      prompt: '',
      status: 'complete',
      message: 'Complete',
      assistantText: failure,
      thinkingText: '',
      tools: [],
      completed: true,
      succeeded: true,
      error: null,
    },
  };
  const runtimeFailure: Message = {
    id: 'runtime-provider-failure',
    role: 'owned-agent',
    text: failure,
    time: '17:30',
    turn: {
      id: 'runtime-turn:provider-failure',
      sessionId: 'session:test',
      prompt: '',
      status: 'failed',
      message: 'Request failed',
      assistantText: '',
      thinkingText: '',
      tools: [],
      completed: true,
      succeeded: false,
      error: failure,
    },
  };

  const merged = mergeCanonicalHistoryIntoRuntime([canonicalFailure], [runtimeFailure]);

  assert.deepEqual(merged.map((message) => message.id), ['runtime-provider-failure']);
  assert.equal(shouldUseCanonicalMessages([runtimeFailure], [canonicalFailure]), false);
});

test('desktop entry aliases reconcile tool-only canonical and runtime turns after returning to a parent fork', () => {
  const identities = new Map([
    ['human:me', {
      id: 'human:me',
      kind: 'human',
      displayName: 'Me',
      source: 'local',
      avatarKey: 'human:me',
      createdAtMs: 1,
      updatedAtMs: 1,
    }],
    ['agent:me', {
      id: 'agent:me',
      kind: 'agent',
      displayName: 'Kordi',
      ownerIdentityId: 'human:me',
      source: 'local',
      avatarKey: 'agent:me',
      createdAtMs: 1,
      updatedAtMs: 1,
    }],
  ]);
  const canonicalMessage = mapCanonicalMessage({
    id: 'msg:canonical-tool-turn',
    sessionId: 'session:parent',
    senderIdentityId: 'agent:me',
    senderRole: 'owned-agent',
    messageKind: 'agent-turn',
    contentText: '',
    content: {
      desktopEntryId: 'entry:runtime-tool-turn',
      thinkingText: 'Inspecting the issue',
      timeLabel: '16:05',
      tools: [{
        id: 'tool:edit',
        name: 'edit',
        status: 'error',
        arguments: '{}',
        liveOutput: '',
        isError: true,
      }],
    },
    status: 'complete',
    sequenceNum: 6,
    createdAtMs: 6,
    updatedAtMs: 6,
    sourceTransport: 'desktop-chat',
  }, identities, 'human:me');
  assert.ok(canonicalMessage);
  assert.equal(canonicalMessage.entryId, 'entry:runtime-tool-turn');

  const runtimeMessage: Message = {
    id: 'desktop-message:session:parent:6:owned-agent',
    entryId: 'entry:runtime-tool-turn',
    role: 'owned-agent',
    sender: 'My Kordi',
    text: '',
    time: '16:05',
    turn: {
      id: 'runtime-tool-turn',
      sessionId: 'session:parent',
      prompt: '',
      status: 'succeeded',
      message: 'Response complete',
      assistantText: '',
      thinkingText: 'Inspecting the issue',
      tools: [{
        id: 'tool:edit',
        name: 'edit',
        status: 'error',
        arguments: '{}',
        liveOutput: '',
        isError: true,
      }],
      completed: true,
      succeeded: false,
      error: null,
    },
  };

  const merged = mergeCanonicalHistoryIntoRuntime([canonicalMessage], [runtimeMessage]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.id, runtimeMessage.id);
  assert.deepEqual(merged[0]?.replyAliasIds, [
    'msg:canonical-tool-turn',
    'entry:runtime-tool-turn',
  ]);

  const forkSnapshot = mapCanonicalMessage({
    id: 'msg:fork-snapshot-tool-turn',
    sessionId: 'session:fork',
    senderIdentityId: 'agent:me',
    senderRole: 'owned-agent',
    messageKind: 'agent-turn',
    contentText: '',
    content: {
      desktopEntryId: 'entry:runtime-tool-turn',
      timeLabel: '16:05',
    },
    status: 'complete',
    sequenceNum: 1,
    createdAtMs: 6,
    updatedAtMs: 6,
    sourceTransport: 'canonical-fork-snapshot',
  }, identities, 'human:me');
  assert.equal(forkSnapshot?.entryId, 'msg:fork-snapshot-tool-turn');
});

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

test('workspace view model hides cloud-agent runtime sessions from local chat UI', () => {
  let viewModels: ReturnType<typeof useWorkspaceViewModels> | null = null;
  function Probe() {
    viewModels = useWorkspaceViewModels({
      isNativeShell: true,
      isDesktopChatLoading: false,
      desktopChatState: {
        cwd: '/tmp',
        activeSessionId: 'cloud-agent:acct_me:acct_peer',
        sessions: [
          { id: 'cloud-agent:acct_me:acct_peer', title: 'Cloud agent runtime', subtitle: 'hidden', updatedAtLabel: '12:00', messageCount: 1, draft: false },
          { id: 'local-visible', title: 'Visible local chat', subtitle: 'shown', updatedAtLabel: '12:01', messageCount: 1, draft: false },
        ],
        projects: [],
        activeSession: {
          id: 'cloud-agent:acct_me:acct_peer',
          title: 'Cloud agent runtime',
          subtitle: 'hidden',
          provider: 'openai',
          providerLabel: 'OpenAI',
          model: 'gpt',
          modelLabel: 'GPT',
          thinking: 'default',
          thinkingLabel: 'Default',
          thinkingLevels: [],
          updatedAtLabel: '12:00',
          messageCount: 1,
          draft: false,
          contextWindowText: '',
          contextWindowStatus: { contextWindow: 0, usedTokens: 0, percentUsed: 0, status: 'ok' },
          project: null,
          messages: [{ role: 'user', text: 'internal prompt', timeLabel: '12:00', timestampMs: 1 }],
        },
        localAgent: { label: 'Kordi', systemPrompt: '', loadedSkills: [], loadedTools: [], loadedPlugins: [], identityFiles: [], defaultProvider: 'openai', defaultModel: 'gpt', workspaceRoot: '/tmp', lastActivities: [] },
        modelOptions: [],
        slashCommands: [],
      } as never,
      desktopCollaborationState: null,
      canonicalSessionState: null,
      hiddenSessionIds: new Set(),
      projectWorkspaces: [],
      projectSelectedSessionIds: {},
      activeNav: 'chats',
      activeConvId: 'my-agent',
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
      mapDesktopMessages: (_sessionId, messages) => messages.map((message) => ({ role: message.role === 'assistant' ? 'owned-agent' : 'user', text: message.text, time: message.timeLabel })),
    });
    return null;
  }

  renderToStaticMarkup(createElement(Probe));

  assert.equal(viewModels?.chatConversations.some((conversation) => conversation.id.startsWith('cloud-agent:')), false);
  assert.equal(viewModels?.activeConv.id, 'local-visible');
});

test('workspace view model exposes visible non-contact Bridge people for Add contacts only', () => {
  let viewModels: ReturnType<typeof useWorkspaceViewModels> | null = null;
  function Probe() {
    viewModels = useWorkspaceViewModels({
      isNativeShell: true,
      isDesktopChatLoading: false,
      desktopChatState: null,
      desktopCollaborationState: {
        activeHostId: 'host-1',
        hosts: [{
          id: 'host-1',
          registered: true,
          connected: true,
          serverUrl: 'https://bridge.test',
          nodeId: 'kd_me',
          displayName: 'Me',
          ownerName: 'Me',
          endpoint: 'https://bridge.test/kd_me',
          tokenPresent: true,
          humanId: 'kh_me',
          discoveryMode: 'open',
          humanVisibilityPolicy: 'server-approval',
          contactApprovalPolicy: 'approval-required',
          activeAgentId: null,
          agents: [],
          visiblePeers: [{
            nodeId: 'kd_visible',
            displayName: 'Kordi User 6',
            runtime: 'person',
            endpoint: '',
            ownerName: 'Kordi User 6',
            createdAt: null,
            sharedProjects: [],
            humanId: 'kh_visible',
            agentId: null,
            isDefaultAgent: false,
            discoveryMode: null,
            humanVisibilityPolicy: 'server-approval',
            contactApprovalPolicy: 'approval-required',
            agentReachabilityPolicy: 'contacts',
            isContact: false,
            contactRequestStatus: null,
            contactRequestDirection: null,
          }, {
            nodeId: 'kd_contact',
            displayName: 'Existing Contact',
            runtime: 'person',
            endpoint: '',
            ownerName: 'Existing Contact',
            createdAt: null,
            sharedProjects: [],
            humanId: 'kh_contact',
            agentId: null,
            isDefaultAgent: false,
            discoveryMode: null,
            humanVisibilityPolicy: 'server-open',
            contactApprovalPolicy: 'auto',
            agentReachabilityPolicy: 'contacts',
            isContact: true,
            contactRequestStatus: 'contact',
            contactRequestDirection: null,
          }],
          visiblePeerCount: 2,
          projects: [],
          contactRequests: [],
          lastError: null,
        }],
        conversations: [],
      } as never,
      canonicalSessionState: null,
      hiddenSessionIds: new Set(),
      projectWorkspaces: [],
      projectSelectedSessionIds: {},
      activeNav: 'contacts',
      activeConvId: '',
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

  assert.deepEqual(viewModels?.addableContacts.map((contact) => contact.name), ['Kordi User 6']);
  assert.equal(viewModels?.displayedContacts.some((contact) => contact.name === 'Kordi User 6'), false);
  assert.equal(viewModels?.displayedContacts.some((contact) => contact.name === 'Existing Contact'), true);
});

test('canonical read model keeps existing local transcript when canonical has equal message count', () => {
  const existingMessages = [
    { id: 'local-user', role: 'user' as const, text: 'hello', time: '11:41', isOwnMessage: true },
  ];
  const canonicalMessages = [
    { id: 'canonical-user', role: 'user' as const, text: 'hello', time: '11:41', isOwnMessage: true },
  ];

  assert.equal(shouldUseCanonicalMessages(existingMessages, canonicalMessages), false);
});

test('canonical read model prefers equal-count canonical transcript when it adds fork snapshot markers', () => {
  const existingMessages = [
    { id: 'local-old', role: 'user' as const, text: 'old question', time: '11:41', isOwnMessage: true },
    { id: 'local-new', role: 'user' as const, text: 'new fork input', time: '11:42', isOwnMessage: true },
  ];
  const canonicalMessages = [
    { id: 'canonical-old', role: 'user' as const, text: 'old question', time: '11:41', isOwnMessage: true, isForkSnapshot: true },
    { id: 'canonical-new', role: 'user' as const, text: 'new fork input', time: '11:42', isOwnMessage: true },
  ];

  assert.equal(shouldUseCanonicalMessages(existingMessages, canonicalMessages), true);
});

test('canonical fork snapshot markers enrich matching runtime messages after hydration', () => {
  const runtimeMessages = [
    { id: 'runtime-user', entryId: 'entry:user', role: 'user' as const, text: 'old question', time: '11:41', isOwnMessage: true },
    {
      id: 'runtime-agent',
      entryId: 'entry:agent',
      role: 'owned-agent' as const,
      text: '',
      time: '11:42',
      turn: {
        id: 'turn:runtime-agent',
        sessionId: 'session:fork',
        prompt: '',
        status: 'complete' as const,
        message: 'Complete',
        assistantText: 'old answer',
        thinkingText: '',
        tools: [],
        completed: true,
        succeeded: true,
        error: null,
      },
    },
  ];
  const canonicalMessages = [
    { id: 'msg:canonical-user', role: 'user' as const, text: 'old question', time: '11:41', isOwnMessage: true, isForkSnapshot: true },
    {
      id: 'msg:canonical-agent',
      role: 'owned-agent' as const,
      text: '',
      time: '11:42',
      isForkSnapshot: true,
      turn: {
        id: 'turn:canonical-agent',
        sessionId: 'session:fork',
        prompt: '',
        status: 'complete' as const,
        message: 'Complete',
        assistantText: 'old answer',
        thinkingText: '',
        tools: [],
        completed: true,
        succeeded: true,
        error: null,
      },
    },
  ];

  const merged = mergeCanonicalHistoryIntoRuntime(canonicalMessages, runtimeMessages);
  assert.equal(merged.length, 2);
  assert.equal(merged[0]?.isForkSnapshot, true);
  assert.equal(merged[1]?.isForkSnapshot, true);
  assert.deepEqual(merged[1]?.replyAliasIds, ['msg:canonical-agent']);
});

test('restored Cloud self-agent messages are sent as native context for continued local turns', () => {
  const contextMessages = restoredSelfAgentContextMessages([
    {
      id: 'msg:cloud:self:user-1',
      role: 'user',
      sender: 'Me',
      senderType: 'human',
      text: 'What is the weather in Thuwal, Saudi Arabia today?',
      time: '14:30',
      isOwnMessage: true,
    },
    {
      id: 'msg:cloud:self:agent-1',
      role: 'owned-agent',
      sender: 'My Kordi',
      senderType: 'agent',
      text: '',
      time: '14:31',
      turn: {
        id: 'turn-1',
        sessionId: 'session:restored',
        prompt: 'What is the weather in Thuwal, Saudi Arabia today?',
        status: 'succeeded',
        message: 'Response complete',
        assistantText: 'Thuwal is cloudy today.',
        thinkingText: '',
        tools: [],
        completed: true,
        succeeded: true,
        error: null,
      },
    },
    {
      id: 'msg:cloud:self:legacy-forward',
      role: 'user',
      sender: 'Me',
      senderType: 'human',
      text: '@MyKordi this copied mention is display-only',
      time: '14:32',
      isOwnMessage: true,
      messageAction: {
        schemaVersion: 1,
        kind: 'forward',
        source: {
          sourceSessionId: 'session:source',
          sourceMessageId: 'msg:source',
          senderLabel: 'Me',
          textPreview: '@MyKordi this copied mention is display-only',
          attachmentCount: 0,
        },
      },
    },
    {
      id: 'msg:ui:local-new',
      role: 'user',
      sender: 'Me',
      senderType: 'human',
      text: 'Can you see the chat history here?',
      time: '14:33',
      isOwnMessage: true,
    },
  ]);

  assert.deepEqual(contextMessages, [
    {
      id: 'msg:cloud:self:user-1',
      authorName: 'Me',
      authorKind: 'human',
      text: 'What is the weather in Thuwal, Saudi Arabia today?',
      createdAtMs: null,
    },
    {
      id: 'msg:cloud:self:agent-1',
      authorName: 'My Kordi',
      authorKind: 'agent',
      text: 'Thuwal is cloudy today.',
      createdAtMs: null,
    },
  ]);
});

test('canonical self-agent fork snapshots are sent as native context for the first local turn', () => {
  const contextMessages = restoredSelfAgentContextMessages([
    {
      id: 'msg:fork:user-1',
      role: 'user',
      sender: 'Me',
      senderType: 'human',
      text: 'Review the current implementation',
      time: '16:04',
      isOwnMessage: true,
      isForkSnapshot: true,
    },
    {
      id: 'desktop-message:fork:agent-1',
      entryId: 'entry:runtime-agent-1',
      replyAliasIds: ['msg:fork:agent-1'],
      role: 'owned-agent',
      sender: 'My Kordi',
      senderType: 'agent',
      text: '',
      time: '16:05',
      isForkSnapshot: true,
      turn: {
        id: 'turn:fork:agent-1',
        sessionId: 'session:fork',
        prompt: 'Review the current implementation',
        status: 'succeeded',
        message: 'Response complete',
        assistantText: 'I found one issue in the fork context handoff.',
        thinkingText: '',
        tools: [],
        completed: true,
        succeeded: true,
        error: null,
      },
    },
    {
      id: 'msg:ordinary-local',
      role: 'user',
      sender: 'Me',
      senderType: 'human',
      text: 'Do not import ordinary visible local history.',
      time: '16:06',
      isOwnMessage: true,
    },
  ]);

  assert.deepEqual(contextMessages, [
    {
      id: 'msg:fork:user-1',
      authorName: 'Me',
      authorKind: 'human',
      text: 'Review the current implementation',
      createdAtMs: null,
    },
    {
      id: 'msg:fork:agent-1',
      authorName: 'My Kordi',
      authorKind: 'agent',
      text: 'I found one issue in the fork context handoff.',
      createdAtMs: null,
    },
  ]);
});

test('canonical read model keeps a creator-anchored group name and normalizes stale remote self roles', () => {
  const readModel = createCanonicalSessionReadModel({
    storagePath: '/tmp/canonical.sqlite3',
    profile: {
      id: 'profile:user1',
      displayName: 'Testuser1',
      humanIdentityId: 'human:user1',
      activeAgentIdentityId: null,
      storageRoot: '/tmp',
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    identities: [
      { id: 'human:user1', kind: 'human', displayName: 'Testuser1', source: 'bridge', humanId: 'kh_user1', sourceIdentityId: 'kd_user1', avatarKey: 'user1', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'human:user2', kind: 'human', displayName: 'Testuser2', source: 'bridge', humanId: 'kh_user2', sourceIdentityId: 'kd_user2', avatarKey: 'user2', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'human:user3', kind: 'human', displayName: 'Testuser3', source: 'bridge', humanId: 'kh_user3', sourceIdentityId: 'kd_user3', avatarKey: 'user3', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [{
      id: 'session:group:shared',
      kind: 'group',
      title: 'New test group',
      status: 'active',
      createdByIdentityId: 'human:user2',
      primaryIdentityId: null,
      relationshipIdentityId: null,
      metadata: { source: 'bridge-session-thread', groupId: 'session:group:shared', groupSpaceId: 'session:group:shared' },
      createdAtMs: 1,
      updatedAtMs: 1,
      lastMessageAtMs: 2,
    }],
    participants: [
      { sessionId: 'session:group:shared', identityId: 'human:user1', role: 'self', state: 'active', addedByIdentityId: 'human:user2', addedAtMs: 1 },
      { sessionId: 'session:group:shared', identityId: 'human:user2', role: 'self', state: 'active', addedByIdentityId: 'human:user2', addedAtMs: 1 },
      { sessionId: 'session:group:shared', identityId: 'human:user3', role: 'person', state: 'active', addedByIdentityId: 'human:user2', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg:group:first', sessionId: 'session:group:shared', senderIdentityId: 'human:user2', senderRole: 'person', messageKind: 'text', contentText: 'hi every one', content: { sender: 'Testuser2', timeLabel: '00:02' }, status: 'sent', sequenceNum: 1, createdAtMs: 2, updatedAtMs: 2, contentHash: null, sourceTransport: 'desktop-bridge-parent', sourceEventId: 'group:first' },
    ],
    delegatedExchanges: [],
    contextSnapshots: [],
    presence: [],
  } as never);

  const conversations = readModel?.buildChatConversations([], (messages, fallback) => messages[0]?.text ?? fallback ?? '') ?? [];
  const space = buildParticipantSpaces(conversations).find((candidate) => candidate.id === 'group:session:group:shared');

  assert.equal(space?.title, 'Testuser1, Testuser3');
  assert.deepEqual(space?.participants.filter((participant) => participant.role === 'self').map((participant) => participant.id), ['human:user1']);
});

test('canonical read model sorts group latest by chat activity instead of metadata sync touches', () => {
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
      { id: 'human:alice', kind: 'human', displayName: 'Alice', source: 'bridge', avatarKey: 'alice', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'human:bob', kind: 'human', displayName: 'Bob', source: 'bridge', avatarKey: 'bob', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      {
        id: 'session:group:old-empty',
        kind: 'group',
        title: 'Alice, Bob',
        status: 'active',
        createdByIdentityId: 'human:me',
        primaryIdentityId: null,
        relationshipIdentityId: null,
        metadata: { createdFrom: 'chat-create-flow', customName: 'Alice, Bob', groupId: 'session:group:old-empty', groupSpaceId: 'session:group:old-empty' },
        createdAtMs: 1_000,
        updatedAtMs: 50_000,
        lastMessageAtMs: null,
      },
      {
        id: 'session:group:testgroup-two',
        kind: 'group',
        title: 'testgroup two',
        status: 'active',
        createdByIdentityId: 'human:me',
        primaryIdentityId: null,
        relationshipIdentityId: null,
        metadata: { createdFrom: 'chat-create-flow', customName: 'testgroup two', groupId: 'session:group:testgroup-two', groupSpaceId: 'session:group:testgroup-two' },
        createdAtMs: 40_000,
        updatedAtMs: 40_000,
        lastMessageAtMs: 45_000,
      },
    ],
    participants: [
      { sessionId: 'session:group:old-empty', identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId: 'session:group:old-empty', identityId: 'human:alice', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId: 'session:group:old-empty', identityId: 'human:bob', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId: 'session:group:testgroup-two', identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId: 'session:group:testgroup-two', identityId: 'human:alice', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId: 'session:group:testgroup-two', identityId: 'human:bob', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg:group:hi', sessionId: 'session:group:testgroup-two', senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: 'hi', content: { sender: 'Me', timeLabel: '09:41' }, status: 'sent', sequenceNum: 1, createdAtMs: 45_000, updatedAtMs: 45_000, contentHash: null, sourceTransport: 'desktop-chat-ui', sourceEventId: 'group:hi' },
    ],
    delegatedExchanges: [],
    contextSnapshots: [],
    presence: [],
  } as never);

  const conversations = readModel?.buildChatConversations([], (messages, fallback) => messages[messages.length - 1]?.text ?? fallback ?? '') ?? [];
  const spaces = buildParticipantSpaces(conversations);

  assert.equal(spaces[0]?.title, 'testgroup two');
  assert.equal(spaces[0]?.sessions[0]?.canonicalSessionId, 'session:group:testgroup-two');
});

test('canonical read model names chat-created direct and group sessions from the first user message', () => {
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
      { id: 'human:alice', kind: 'human', displayName: 'Alice', source: 'local', avatarKey: 'alice', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'human:bob', kind: 'human', displayName: 'Bob', source: 'local', avatarKey: 'bob', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      {
        id: 'session:direct-person:alice-one',
        kind: 'direct-person',
        title: 'Alice',
        status: 'active',
        createdByIdentityId: 'human:me',
        primaryIdentityId: 'human:alice',
        relationshipIdentityId: 'human:alice',
        metadata: { createdFrom: 'chat-create-flow', contactId: 'contact:alice' },
        createdAtMs: 1,
        updatedAtMs: 1,
        lastMessageAtMs: 10,
      },
      {
        id: 'session:group:crew-root',
        kind: 'group',
        title: 'Design crew',
        status: 'active',
        createdByIdentityId: 'human:me',
        primaryIdentityId: null,
        relationshipIdentityId: null,
        metadata: { createdFrom: 'chat-create-flow', customName: 'Design crew', groupId: 'session:group:crew-root', groupSpaceId: 'session:group:crew-root' },
        createdAtMs: 1,
        updatedAtMs: 1,
        lastMessageAtMs: 20,
      },
    ],
    participants: [
      { sessionId: 'session:direct-person:alice-one', identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId: 'session:direct-person:alice-one', identityId: 'human:alice', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId: 'session:group:crew-root', identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId: 'session:group:crew-root', identityId: 'human:alice', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId: 'session:group:crew-root', identityId: 'human:bob', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg:direct:first', sessionId: 'session:direct-person:alice-one', senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: 'Plan lunch tomorrow with the launch notes before standup', content: { sender: 'Me', timeLabel: '10:01' }, status: 'sent', sequenceNum: 1, createdAtMs: 10, updatedAtMs: 10, contentHash: null, sourceTransport: 'desktop-chat-ui', sourceEventId: 'direct:first' },
      { id: 'msg:group:first', sessionId: 'session:group:crew-root', senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: 'Review launch plan and assign owners before demo', content: { sender: 'Me', timeLabel: '10:02' }, status: 'sent', sequenceNum: 1, createdAtMs: 20, updatedAtMs: 20, contentHash: null, sourceTransport: 'desktop-chat-ui', sourceEventId: 'group:first' },
    ],
    delegatedExchanges: [],
    contextSnapshots: [],
    presence: [],
  } as never);

  const conversations = readModel?.buildChatConversations([], (messages, fallback) => messages[0]?.text ?? fallback ?? '') ?? [];
  const directConversation = conversations.find((conversation) => conversation.id === 'session:direct-person:alice-one');
  const groupConversation = conversations.find((conversation) => conversation.id === 'session:group:crew-root');
  const groupSpace = buildParticipantSpaces(conversations).find((space) => space.id === 'group:session:group:crew-root');

  assert.equal(directConversation?.name, 'Plan lunch tomorrow with the launch notes before');
  assert.equal(groupConversation?.name, 'Review launch plan and assign owners before demo');
  assert.equal(groupSpace?.title, 'Design crew');
  assert.equal(groupSpace?.sessions[0]?.title, 'Review launch plan and assign owners before demo');
});

test('canonical read model titles private self-agent forks from the first new turn, not inherited snapshots', () => {
  const sessionId = 'session:fork:self-title';
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
      { id: 'agent:me', kind: 'agent', displayName: 'Kordi', source: 'local', ownerIdentityId: 'human:me', avatarKey: 'agent', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [{
      id: sessionId,
      kind: 'self-agent',
      title: 'hello',
      status: 'active',
      createdByIdentityId: 'human:me',
      primaryIdentityId: 'agent:me',
      relationshipIdentityId: null,
      metadata: { fork: { forkedFromSessionId: 'parent-self-session', forkedFromMessageId: 'parent-agent-message' } },
      createdAtMs: 1,
      updatedAtMs: 40,
      lastMessageAtMs: 40,
    }],
    participants: [
      { sessionId, identityId: 'agent:me', role: 'agent', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'snapshot-user', sessionId, senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: 'Thuwal weather today', content: { sender: 'Me', timeLabel: '11:27' }, status: 'sent', sequenceNum: 1, createdAtMs: 10, updatedAtMs: 10, contentHash: null, sourceTransport: 'canonical-fork-snapshot', sourceEventId: 'snapshot:user' },
      { id: 'snapshot-agent', sessionId, senderIdentityId: 'agent:me', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: 'weather answer', content: { sender: 'Kordi', timeLabel: '11:28' }, status: 'complete', sequenceNum: 2, createdAtMs: 20, updatedAtMs: 20, contentHash: null, sourceTransport: 'canonical-fork-snapshot', sourceEventId: 'snapshot:agent' },
      { id: 'new-user', sessionId, senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: 'hello', content: { sender: 'Me', timeLabel: '11:41' }, status: 'sent', sequenceNum: 3, createdAtMs: 30, updatedAtMs: 30, contentHash: null, sourceTransport: 'desktop-chat', sourceEventId: 'new:user' },
      { id: 'new-agent', sessionId, senderIdentityId: 'agent:me', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: 'Hello! How can I help you today?', content: { sender: 'Kordi', timeLabel: '11:41' }, status: 'complete', sequenceNum: 4, createdAtMs: 40, updatedAtMs: 40, contentHash: null, sourceTransport: 'desktop-chat', sourceEventId: 'new:agent' },
    ],
    delegatedExchanges: [],
    contextSnapshots: [],
    presence: [],
  } as never);

  const conversations = readModel?.buildChatConversations([], (messages, fallback) => messages.at(-1)?.text ?? fallback ?? '') ?? [];
  const forkConversation = conversations.find((conversation) => conversation.id === sessionId);

  assert.equal(forkConversation?.name, 'hello');
});

test('canonical read model ignores inherited manual title metadata when session title is still New session', () => {
  const sessionId = 'session:group:new-child';
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
      { id: 'human:alice', kind: 'human', displayName: 'Alice', source: 'local', avatarKey: 'alice', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'human:bob', kind: 'human', displayName: 'Bob', source: 'local', avatarKey: 'bob', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [{
      id: sessionId,
      kind: 'group',
      title: 'New session',
      status: 'active',
      createdByIdentityId: 'human:me',
      primaryIdentityId: null,
      relationshipIdentityId: null,
      metadata: {
        createdFrom: 'chat-create-flow',
        customName: 'Good group',
        groupId: 'session:group:root',
        groupSpaceId: 'session:group:root',
        titleSource: 'manual',
        sessionTitleSource: 'manual',
      },
      createdAtMs: 1,
      updatedAtMs: 1,
      lastMessageAtMs: 20,
    }],
    participants: [
      { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'human:alice', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'human:bob', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg:first', sessionId, senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: 'HEY GUES', content: { sender: 'Me', timeLabel: '10:47' }, status: 'sent', sequenceNum: 1, createdAtMs: 20, updatedAtMs: 20, contentHash: null, sourceTransport: 'desktop-chat-ui', sourceEventId: 'group:first' },
    ],
    delegatedExchanges: [],
    contextSnapshots: [],
    presence: [],
  } as never);

  const conversations = readModel?.buildChatConversations([], (messages, fallback) => messages[0]?.text ?? fallback ?? '') ?? [];
  const groupConversation = conversations.find((conversation) => conversation.id === sessionId);
  const groupSpace = buildParticipantSpaces(conversations).find((space) => space.id === 'group:session:group:root');

  assert.equal(groupConversation?.name, 'HEY GUES');
  assert.equal(groupSpace?.title, 'Good group');
  assert.equal(groupSpace?.sessions[0]?.title, 'HEY GUES');
});

test('canonical read model prefers a manually renamed session title over the first user message', () => {
  const sessionId = 'session:direct-person:alice-renamed';
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
      { id: 'human:alice', kind: 'human', displayName: 'Alice', source: 'local', avatarKey: 'alice', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [{
      id: sessionId,
      kind: 'direct-person',
      title: 'Renamed lunch thread',
      status: 'active',
      createdByIdentityId: 'human:me',
      primaryIdentityId: 'human:alice',
      relationshipIdentityId: 'human:alice',
      metadata: { createdFrom: 'chat-create-flow', titleSource: 'manual' },
      createdAtMs: 1,
      updatedAtMs: 30,
      lastMessageAtMs: 10,
    }],
    participants: [
      { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'human:alice', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg:direct:first', sessionId, senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: 'Plan lunch tomorrow with the launch notes before standup', content: { sender: 'Me', timeLabel: '10:01' }, status: 'sent', sequenceNum: 1, createdAtMs: 10, updatedAtMs: 10, contentHash: null, sourceTransport: 'desktop-chat-ui', sourceEventId: 'direct:first' },
    ],
    delegatedExchanges: [],
    contextSnapshots: [],
    presence: [],
  } as never);

  const conversations = readModel?.buildChatConversations([], (messages, fallback) => messages[0]?.text ?? fallback ?? '') ?? [];
  const conversation = conversations.find((item) => item.id === sessionId);
  const space = buildParticipantSpaces(conversations).find((item) => item.sessions.some((session) => session.id === sessionId));

  assert.equal(conversation?.name, 'Renamed lunch thread');
  assert.equal(space?.sessions[0]?.title, 'Renamed lunch thread');
});

test('canonical read model keeps group space names separate from first-message session titles after group rename', () => {
  const sessionId = 'session:group:renamed-space';
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
      { id: 'human:alice', kind: 'human', displayName: 'Alice', source: 'local', avatarKey: 'alice', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'human:bob', kind: 'human', displayName: 'Bob', source: 'local', avatarKey: 'bob', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [{
      id: sessionId,
      kind: 'group',
      title: 'Atestgroup',
      status: 'active',
      createdByIdentityId: 'human:me',
      primaryIdentityId: null,
      relationshipIdentityId: null,
      metadata: { customName: 'Atestgroup', groupId: sessionId, groupSpaceId: sessionId, titleSource: 'manual' },
      createdAtMs: 1,
      updatedAtMs: 30,
      lastMessageAtMs: 10,
    }],
    participants: [
      { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'human:alice', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'human:bob', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg:group:first', sessionId, senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: 'hello guys', content: { sender: 'Me', timeLabel: '10:13' }, status: 'sent', sequenceNum: 1, createdAtMs: 10, updatedAtMs: 10, contentHash: null, sourceTransport: 'desktop-chat-ui', sourceEventId: 'group:first' },
    ],
    delegatedExchanges: [],
    contextSnapshots: [],
    presence: [],
  } as never);

  const conversations = readModel?.buildChatConversations([], (messages, fallback) => messages[0]?.text ?? fallback ?? '') ?? [];
  const space = buildParticipantSpaces(conversations).find((item) => item.id === `group:${sessionId}`);

  assert.equal(space?.title, 'Atestgroup');
  assert.equal(space?.sessions[0]?.title, 'hello guys');
});

test('canonical read model can show a manually renamed group session without changing the group space name', () => {
  const sessionId = 'session:group:manual-session-title';
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
      { id: 'human:alice', kind: 'human', displayName: 'Alice', source: 'local', avatarKey: 'alice', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'human:bob', kind: 'human', displayName: 'Bob', source: 'local', avatarKey: 'bob', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [{
      id: sessionId,
      kind: 'group',
      title: 'Sprint retro notes',
      status: 'active',
      createdByIdentityId: 'human:me',
      primaryIdentityId: null,
      relationshipIdentityId: null,
      metadata: { customName: 'Design crew', groupId: sessionId, groupSpaceId: sessionId, sessionTitleSource: 'manual' },
      createdAtMs: 1,
      updatedAtMs: 30,
      lastMessageAtMs: 10,
    }],
    participants: [
      { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'human:alice', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'human:bob', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg:group:first', sessionId, senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: 'hello guys', content: { sender: 'Me', timeLabel: '10:13' }, status: 'sent', sequenceNum: 1, createdAtMs: 10, updatedAtMs: 10, contentHash: null, sourceTransport: 'desktop-chat-ui', sourceEventId: 'group:first' },
    ],
    delegatedExchanges: [],
    contextSnapshots: [],
    presence: [],
  } as never);

  const conversations = readModel?.buildChatConversations([], (messages, fallback) => messages[0]?.text ?? fallback ?? '') ?? [];
  const space = buildParticipantSpaces(conversations).find((item) => item.id === `group:${sessionId}`);

  assert.equal(space?.title, 'Design crew');
  assert.equal(space?.sessions[0]?.title, 'Sprint retro notes');
});

test('canonical read model keeps blank selected-agent sessions visible under My chats', () => {
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
      { id: 'agent:reviewer', kind: 'agent', displayName: 'Reviewer', source: 'local', avatarKey: 'reviewer', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      {
        id: 'session:self-agent:selected-reviewer',
        kind: 'self-agent',
        title: 'Reviewer',
        status: 'active',
        createdByIdentityId: 'human:me',
        primaryIdentityId: 'agent:reviewer',
        relationshipIdentityId: null,
        metadata: { createdFrom: 'chat-create-flow', agentId: 'agent:reviewer', participantSpaceKind: 'self' },
        createdAtMs: 2,
        updatedAtMs: 2,
        lastMessageAtMs: null,
      },
    ],
    participants: [
      { sessionId: 'session:self-agent:selected-reviewer', identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 2 },
      { sessionId: 'session:self-agent:selected-reviewer', identityId: 'agent:reviewer', role: 'delegate', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 2 },
    ],
    messages: [],
    delegatedExchanges: [],
    contextSnapshots: [],
    presence: [],
  });

  const conversations = readModel?.buildChatConversations([], () => '') ?? [];

  assert.equal(conversations.length, 1);
  assert.equal(conversations[0]?.id, 'session:self-agent:selected-reviewer');
  assert.equal(conversations[0]?.type, 'owned-agent');
});

test('canonical read model keeps separate direct person bridge sessions for the same participant', () => {
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
      { id: 'human:bob', kind: 'human', displayName: 'Bob', source: 'bridge', sourceHostId: 'host-1', sourceIdentityId: 'node-shared', humanId: 'human-bob', avatarKey: 'human-bob', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: 'session:bridge:humans:first', kind: 'direct-person', title: 'first hello', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'human:bob', relationshipIdentityId: 'human:bob', metadata: { source: 'bridge-session-thread', sourceHostId: 'host-1', peerNodeId: 'node-shared', peerRuntime: 'person' }, createdAtMs: 1, updatedAtMs: 1, lastMessageAtMs: 1 },
      { id: 'session:bridge:humans:second', kind: 'direct-person', title: 'second hello', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'human:bob', relationshipIdentityId: 'human:bob', metadata: { source: 'bridge-session-thread', sourceHostId: 'host-1', peerNodeId: 'node-shared', peerRuntime: 'person' }, createdAtMs: 2, updatedAtMs: 2, lastMessageAtMs: 2 },
    ],
    participants: [
      { sessionId: 'session:bridge:humans:first', identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId: 'session:bridge:humans:first', identityId: 'human:bob', role: 'delegate', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId: 'session:bridge:humans:second', identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 2 },
      { sessionId: 'session:bridge:humans:second', identityId: 'human:bob', role: 'delegate', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 2 },
    ],
    messages: [],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  } as never);

  const conversations = readModel?.buildChatConversations([], (messages, fallback) => messages[0]?.text ?? fallback ?? '') ?? [];

  assert.deepEqual(conversations.map((conversation) => conversation.id), [
    'session:bridge:humans:second',
    'session:bridge:humans:first',
  ]);
});

test('canonical read model suppresses optimistic bridge UI echo after parent bridge sync confirms send', () => {
  const sessionId = 'session:bridge:humans:bob';
  const readModel = createCanonicalSessionReadModel({
    storagePath: '/tmp/canonical.sqlite3',
    profile: {
      id: 'profile:me',
      displayName: 'Me',
      humanIdentityId: 'human:profile:me',
      activeAgentIdentityId: null,
      storageRoot: '/tmp',
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    identities: [
      { id: 'human:profile:me', kind: 'human', displayName: 'Me', source: 'local', avatarKey: 'me', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'human:bridge:me', kind: 'human', displayName: 'Me', source: 'bridge', sourceHostId: 'host-1', sourceIdentityId: 'node-me', humanId: 'human-me', avatarKey: 'me', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'human:bob', kind: 'human', displayName: 'Bob', source: 'bridge', sourceHostId: 'host-1', sourceIdentityId: 'node-bob', humanId: 'human-bob', avatarKey: 'bob', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: sessionId, kind: 'direct-person', title: 'Bob', status: 'active', createdByIdentityId: 'human:profile:me', primaryIdentityId: 'human:bob', relationshipIdentityId: 'human:bob', metadata: { source: 'bridge-session-thread', sourceHostId: 'host-1', peerNodeId: 'node-bob', peerRuntime: 'person' }, createdAtMs: 1, updatedAtMs: 1_800, lastMessageAtMs: 1_800 },
    ],
    participants: [
      { sessionId, identityId: 'human:bridge:me', role: 'self', state: 'active', addedByIdentityId: 'human:profile:me', addedAtMs: 1 },
      { sessionId, identityId: 'human:bob', role: 'delegate', state: 'active', addedByIdentityId: 'human:profile:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg:ui', sessionId, senderIdentityId: 'human:profile:me', senderRole: 'user', messageKind: 'text', contentText: 'hi shu how are you', content: { sender: 'Me', timeLabel: '19:22' }, status: 'sent', sequenceNum: 1, createdAtMs: 1_000, updatedAtMs: 1_000, contentHash: null, sourceTransport: 'desktop-bridge-ui', sourceEventId: 'desktop-bridge-ui:session:bridge:humans:bob:1000' },
      { id: 'msg:parent', sessionId, senderIdentityId: 'human:bridge:me', senderRole: 'user', messageKind: 'text', contentText: 'hi shu how are you', content: { sender: 'Me', timeLabel: '19:22', deliveryState: 'read', sourceConversationId: 'bridge:host-1:node-bob:person' }, status: 'read', sequenceNum: 2, createdAtMs: 1_800, updatedAtMs: 1_800, contentHash: null, sourceTransport: 'desktop-bridge-parent', sourceEventId: 'desktop-bridge-parent:session:bridge:humans:bob:bridge:host-1:node-bob:person:bridge_msg_1' },
    ],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  } as never);

  assert.ok(readModel);

  const [conversation] = readModel.buildChatConversations([], (messages, fallback) => messages[0]?.text || fallback || '');

  assert.equal(conversation.messages.length, 1);
  assert.equal(conversation.messages[0]?.text, 'hi shu how are you');
  assert.deepEqual(conversation.messages[0]?.statusChips, ['read']);
});

test('canonical read model preserves unread count from source bridge conversation', () => {
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
      { id: 'human:bob', kind: 'human', displayName: 'Bob', source: 'bridge', sourceHostId: 'host-1', sourceIdentityId: 'node-bob', humanId: 'human-bob', avatarKey: 'bob', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: 'session:bridge:humans:unread', kind: 'direct-person', title: 'Bob', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'human:bob', relationshipIdentityId: 'human:bob', metadata: { source: 'bridge-session-thread', sourceHostId: 'host-1', peerNodeId: 'node-bob', peerRuntime: 'person' }, createdAtMs: 1, updatedAtMs: 2, lastMessageAtMs: 2 },
    ],
    participants: [
      { sessionId: 'session:bridge:humans:unread', identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId: 'session:bridge:humans:unread', identityId: 'human:bob', role: 'delegate', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg-1', sessionId: 'session:bridge:humans:unread', senderIdentityId: 'human:bob', senderRole: 'person', messageKind: 'text', contentText: 'Unread hello', content: { sender: 'Bob', timeLabel: '10:00' }, status: 'delivered', sequenceNum: 1, createdAtMs: 2, updatedAtMs: 2, contentHash: null, sourceTransport: 'desktop-bridge-parent', sourceEventId: 'unread-1' },
    ],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  } as never);

  assert.ok(readModel);

  const sourceConversation = {
    id: 'bridge:host-1:node-bob:person',
    canonicalSessionId: 'session:bridge:humans:unread',
    name: 'Bob',
    type: 'person' as const,
    subtitle: 'Direct person chat',
    unread: 3,
    collaborationSources: ['Bridge'],
    trust: 'Bridge',
    directness: 'Direct person chat',
    participants: ['Me', 'Bob'],
    messages: [{ role: 'person' as const, sender: 'Bob', text: 'Unread hello', time: '10:00' }],
  };

  const [conversation] = readModel.buildChatConversations([sourceConversation], (messages, fallback) => messages[0]?.text || fallback || '');

  assert.equal(conversation.unread, 3);
});

test('canonical read model preserves unread count when bridge source is routed by outreach parent session', () => {
  const latestSessionId = 'session:bridge:humans:latest';
  const olderSessionId = 'session:bridge:humans:older';
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
      { id: 'human:bob', kind: 'human', displayName: 'Bob', source: 'bridge', sourceHostId: 'host-1', sourceIdentityId: 'node-bob', humanId: 'human-bob', avatarKey: 'bob', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: latestSessionId, kind: 'direct-person', title: 'new unread', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'human:bob', relationshipIdentityId: 'human:bob', metadata: { source: 'bridge-session-thread', sourceConversationId: 'bridge:host-1:node-bob:person', sourceHostId: 'host-1', peerNodeId: 'node-bob', peerRuntime: 'person' }, createdAtMs: 2, updatedAtMs: 3, lastMessageAtMs: 3 },
      { id: olderSessionId, kind: 'direct-person', title: 'old thread', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'human:bob', relationshipIdentityId: 'human:bob', metadata: { source: 'bridge-session-thread', sourceConversationId: 'bridge:host-1:node-bob:person', sourceHostId: 'host-1', peerNodeId: 'node-bob', peerRuntime: 'person' }, createdAtMs: 1, updatedAtMs: 1, lastMessageAtMs: 1 },
    ],
    participants: [
      { sessionId: latestSessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId: latestSessionId, identityId: 'human:bob', role: 'delegate', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId: olderSessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId: olderSessionId, identityId: 'human:bob', role: 'delegate', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg-latest', sessionId: latestSessionId, senderIdentityId: 'human:bob', senderRole: 'person', messageKind: 'text', contentText: 'new unread', content: { sender: 'Bob', timeLabel: '10:03' }, status: 'delivered', sequenceNum: 1, createdAtMs: 3, updatedAtMs: 3, contentHash: null, sourceTransport: 'desktop-bridge-parent', sourceEventId: 'latest-1' },
      { id: 'msg-older', sessionId: olderSessionId, senderIdentityId: 'human:bob', senderRole: 'person', messageKind: 'text', contentText: 'old thread', content: { sender: 'Bob', timeLabel: '10:01' }, status: 'delivered', sequenceNum: 1, createdAtMs: 1, updatedAtMs: 1, contentHash: null, sourceTransport: 'desktop-bridge-parent', sourceEventId: 'older-1' },
    ],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  } as never);

  assert.ok(readModel);

  const sourceConversation = {
    id: 'bridge:host-1:node-bob:person',
    canonicalSessionId: 'session:bridge:humans:stable-pair',
    name: 'Bob',
    type: 'person' as const,
    subtitle: 'Direct person chat',
    unread: 2,
    collaborationUnreadByParentSessionId: { [latestSessionId]: 1, [olderSessionId]: 1 },
    collaborationSources: ['Bridge'],
    trust: 'Bridge',
    directness: 'Direct person chat',
    participants: ['Me', 'Bob'],
    messages: [{ role: 'person' as const, sender: 'Bob', text: 'new unread', time: '10:03' }],
    outreach: { parentSessionId: latestSessionId },
  };

  const conversations = readModel.buildChatConversations([sourceConversation as never], (messages, fallback) => messages[0]?.text || fallback || '');

  const latestConversation = conversations.find((conversation) => conversation.canonicalSessionId === latestSessionId);
  assert.equal(latestConversation?.id, latestSessionId);
  assert.equal(latestConversation?.unread, 1);
  assert.equal(conversations.find((conversation) => conversation.canonicalSessionId === olderSessionId)?.unread, 1);
  assert.equal(conversations.some((conversation) => conversation.id === 'bridge:host-1:node-bob:person'), false);
});

test('workspace view model hydrates hidden bridge outreach unread into its canonical session', () => {
  const sessionId = 'session:bridge:humans:hidden-unread';
  const olderSessionId = 'session:bridge:humans:older-hidden-unread';
  const sourceConversationId = 'bridge:host-1:node-bob:person';
  const bridgeConversation = {
    id: sourceConversationId,
    canonicalSessionId: 'session:bridge:humans:stable-pair',
    hostId: 'host-1',
    peerNodeId: 'node-bob',
    peerDisplayName: 'Bob',
    peerOwnerName: 'Bob',
    peerRuntime: 'person',
    projectId: null,
    projectName: null,
    title: 'Hi shu',
    subtitle: 'Hi shu',
    unreadCount: 2,
    updatedAtMs: 3,
    updatedAtLabel: '16:07',
    awaitingReply: false,
    peerTyping: false,
    peerLastHeartbeatLabel: null,
    outreach: {
      targetKind: 'person',
      parentSessionId: sessionId,
      sourceHostId: 'host-1',
      sourceConversationId,
      sourceRequestId: 'bridge_req_hidden',
      targetNodeId: 'node-bob',
      targetDisplayName: 'Bob',
      requestText: 'Hi shu',
      status: 'completed',
      createdAtMs: 3,
      updatedAtMs: 3,
    },
    identity: null,
    messages: [{
      id: 'bridge-msg-older-hidden',
      direction: 'inbound',
      sender: 'Bob',
      text: 'Earlier unread',
      timeLabel: '16:03',
      timestampMs: 2,
      requestId: 'bridge_req_older_hidden',
      deliveryState: null,
      outreach: {
        targetKind: 'person',
        parentSessionId: olderSessionId,
        sourceHostId: 'host-1',
        sourceConversationId,
        sourceRequestId: 'bridge_req_older_hidden',
        targetNodeId: 'node-bob',
        targetDisplayName: 'Bob',
        requestText: 'Earlier unread',
        status: 'completed',
        createdAtMs: 2,
        updatedAtMs: 2,
      },
    }, {
      id: 'bridge-msg-hidden',
      direction: 'inbound',
      sender: 'Bob',
      text: 'Hi shu',
      timeLabel: '16:07',
      timestampMs: 3,
      requestId: 'bridge_req_hidden',
      deliveryState: null,
      outreach: {
        targetKind: 'person',
        parentSessionId: sessionId,
        sourceHostId: 'host-1',
        sourceConversationId,
        sourceRequestId: 'bridge_req_hidden',
        targetNodeId: 'node-bob',
        targetDisplayName: 'Bob',
        requestText: 'Hi shu',
        status: 'completed',
        createdAtMs: 3,
        updatedAtMs: 3,
      },
    }],
  };
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
      { id: 'human:bob', kind: 'human', displayName: 'Bob', source: 'bridge', sourceHostId: 'host-1', sourceIdentityId: 'node-bob', humanId: 'human-bob', avatarKey: 'bob', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: sessionId, kind: 'direct-person', title: 'Hi shu', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'human:bob', relationshipIdentityId: 'human:bob', metadata: { source: 'bridge-session-thread', sourceConversationId, sourceHostId: 'host-1', peerNodeId: 'node-bob', peerRuntime: 'person' }, createdAtMs: 2, updatedAtMs: 3, lastMessageAtMs: 3 },
      { id: olderSessionId, kind: 'direct-person', title: 'Earlier unread', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'human:bob', relationshipIdentityId: 'human:bob', metadata: { source: 'bridge-session-thread', sourceConversationId, sourceHostId: 'host-1', peerNodeId: 'node-bob', peerRuntime: 'person' }, createdAtMs: 1, updatedAtMs: 2, lastMessageAtMs: 2 },
    ],
    participants: [
      { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'human:bob', role: 'delegate', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId: olderSessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId: olderSessionId, identityId: 'human:bob', role: 'delegate', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg-hidden', sessionId, senderIdentityId: 'human:bob', senderRole: 'person', messageKind: 'text', contentText: 'Hi shu', content: { sender: 'Bob', timeLabel: '16:07' }, status: 'delivered', sequenceNum: 1, createdAtMs: 3, updatedAtMs: 3, contentHash: null, sourceTransport: 'desktop-bridge-parent', sourceEventId: 'hidden-1' },
      { id: 'msg-older-hidden', sessionId: olderSessionId, senderIdentityId: 'human:bob', senderRole: 'person', messageKind: 'text', contentText: 'Earlier unread', content: { sender: 'Bob', timeLabel: '16:03' }, status: 'delivered', sequenceNum: 1, createdAtMs: 2, updatedAtMs: 2, contentHash: null, sourceTransport: 'desktop-bridge-parent', sourceEventId: 'older-hidden-1' },
    ],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  };
  let viewModels: ReturnType<typeof useWorkspaceViewModels> | null = null;
  function Probe() {
    viewModels = useWorkspaceViewModels({
      isNativeShell: true,
      isDesktopChatLoading: false,
      desktopChatState: null,
      desktopCollaborationState: {
        activeHostId: 'host-1',
        hosts: [{
          id: 'host-1',
          registered: true,
          connected: true,
          serverUrl: 'https://bridge.test',
          nodeId: 'node-me',
          displayName: 'Me',
          ownerName: 'Me',
          endpoint: 'https://bridge.test',
          tokenPresent: true,
          humanId: 'human-me',
          discoveryMode: 'ask',
          activeAgentId: null,
          agents: [],
          visiblePeers: [],
          visiblePeerCount: 0,
          projects: [],
        }],
        conversations: [bridgeConversation],
      } as never,
      canonicalSessionState: canonicalState as never,
      hiddenSessionIds: new Set(),
      projectWorkspaces: [],
      projectSelectedSessionIds: {},
      activeNav: 'chats',
      activeConvId: 'draft:local-chat',
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

  const sessionConversation = viewModels?.chatConversations.find((conversation) => conversation.canonicalSessionId === sessionId);
  assert.equal(sessionConversation?.id, sessionId);
  assert.equal(sessionConversation?.unread, 1);
  assert.equal(viewModels?.chatConversations.find((conversation) => conversation.canonicalSessionId === olderSessionId)?.unread, 1);
  assert.equal(viewModels?.chatConversations.some((conversation) => conversation.id === sourceConversationId), false);
});

test('canonical read model exposes transient Cloud group unread counts on synthetic sessions', () => {
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
      { id: 'human:peer', kind: 'human', displayName: 'Peer', source: 'bridge', sourceHostId: 'cloud', humanId: 'acct_peer', sourceIdentityId: 'acct_peer', avatarKey: 'peer', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [{
      id: 'session:group:cloud-child',
      kind: 'group',
      title: 'Cloud child',
      status: 'active',
      createdByIdentityId: 'human:me',
      primaryIdentityId: null,
      relationshipIdentityId: null,
      projectId: null,
      projectName: null,
      metadata: { source: 'cloud-group', groupSpaceId: 'session:group:cloud-space', customName: 'Cloud group', cloudUnreadCount: 2 },
      createdAtMs: 1,
      updatedAtMs: 3,
      lastMessageAtMs: 3,
    }],
    participants: [
      { sessionId: 'session:group:cloud-child', identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId: 'session:group:cloud-child', identityId: 'human:peer', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg:peer', sessionId: 'session:group:cloud-child', senderIdentityId: 'human:peer', senderRole: 'person', messageKind: 'text', contentText: 'Unread hello', content: { sender: 'Peer', timeLabel: '10:00' }, status: 'sent', sequenceNum: 1, createdAtMs: 3, updatedAtMs: 3, contentHash: null, sourceTransport: 'cloud-group', sourceEventId: 'cloud_1' },
    ],
    delegatedExchanges: [],
    contextSnapshots: [],
    presence: [],
  } as never);

  const conversations = readModel?.buildChatConversations([], (messages, fallback) => messages[0]?.text ?? fallback ?? '') ?? [];
  const conversation = conversations.find((item) => item.canonicalSessionId === 'session:group:cloud-child');
  const participantSpaces = buildParticipantSpaces(conversations);

  assert.equal(conversation?.unread, 2);
  assert.equal(participantSpaces.find((space) => space.id === 'group:session:group:cloud-space')?.unread, 2);
});
