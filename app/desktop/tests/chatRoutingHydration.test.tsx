import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { stripDerivedCloudUnreadCounts } from '../src/app/useKordiAppModelHelpers';
import {
  activeConversationForSelection,
  applyCanonicalHydrationPlaceholder,
  pendingCloudCollaborationConversationForActiveId,
  useWorkspaceViewModels,
} from '../src/app/useWorkspaceViewModels';
import type { CanonicalSessionState } from '../src/kordi-app/types';

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

test('new Cloud contact selection opens an empty usable chat instead of waiting forever', () => {
  const conversation = pendingCloudCollaborationConversationForActiveId('bridge:cloud:acct_peer:person');

  assert.equal(conversation?.id, 'bridge:cloud:acct_peer:person');
  assert.equal(conversation?.collaborationTarget?.hostId, 'cloud');
  assert.equal(conversation?.collaborationTarget?.nodeId, 'acct_peer');
  assert.equal(conversation?.name, 'New contact chat');
  assert.equal(conversation?.collaborationSources.includes('Cloud'), true);
  assert.equal(conversation?.subtitle, '');
  assert.deepEqual(conversation?.participants, ['Me', 'Contact']);
  assert.equal(conversation?.messages.length, 0);
});

test('workspace active conversation resolves Cloud self-agent bridge session ids to restored canonical sessions', () => {
  const localConversation = {
    id: 'session-local-restored',
    canonicalSessionId: 'session-local-restored',
    name: 'Weekly forecast',
    type: 'owned-agent' as const,
    subtitle: 'Local restored self-agent chat',
    unread: 0,
    collaborationSources: ['Local'],
    trust: 'Owned',
    directness: 'Direct chat',
    participants: ['Me', 'My Kordi'],
    messages: [{ role: 'user' as const, isOwnMessage: true, text: 'Please summarize the forecast.', time: '11:27' }],
  };
  const cloudBridgeSelection = 'bridge:cloud:acct_me:session:session-local-restored';

  const selected = activeConversationForSelection(
    cloudBridgeSelection,
    [localConversation],
    { isNativeShell: true, nativeChatPlaceholder: localConversation },
  );

  assert.equal(selected.id, localConversation.id);
  assert.equal(selected.messages[0]?.text, 'Please summarize the forecast.');
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
  assert.equal(selected.subtitle, '');
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
  assert.equal(selected.subtitle, '');
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

test('canonical history loading keeps one transcript notice without replacing the header subtitle', () => {
  const selected = {
    id: 'session:group:history',
    canonicalSessionId: 'session:group:history',
    canonicalMessageCount: 5,
    name: 'main',
    type: 'owned-agent' as const,
    subtitle: 'Latest synced message',
    unread: 0,
    collaborationSources: ['Cloud'],
    trust: 'Bridge',
    directness: 'Group chat',
    participants: ['Me', 'Alice'],
    messages: [],
  };

  const loading = applyCanonicalHydrationPlaceholder(selected, 'loading');

  assert.equal(loading.subtitle, 'Latest synced message');
  assert.deepEqual(loading.messages.map((message) => message.text), ['Loading chat history…']);
  assert.equal(loading.messages[0]?.detail, 'transcript-loading');
});

test('contact history loading uses the same single neutral transcript notice', () => {
  const selected = {
    id: 'session:direct-person:acct_me:acct_peer',
    canonicalSessionId: 'session:direct-person:acct_me:acct_peer',
    canonicalMessageCount: 3,
    name: 'Maya Chen',
    type: 'person' as const,
    subtitle: 'Latest synced contact message',
    unread: 0,
    collaborationSources: ['Cloud'],
    trust: 'Bridge',
    directness: 'Person chat',
    participants: ['Me', 'Maya Chen'],
    messages: [],
  };

  const loading = applyCanonicalHydrationPlaceholder(selected, 'loading');

  assert.equal(loading.subtitle, 'Latest synced contact message');
  assert.deepEqual(loading.messages.map((message) => message.text), ['Loading chat history…']);
  assert.equal(loading.messages[0]?.detail, 'transcript-loading');
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
      hydratedDesktopSessionIds: new Set(['local-runtime-session']),
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
