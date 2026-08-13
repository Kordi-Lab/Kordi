import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useWorkspaceViewModels } from '../src/app/useWorkspaceViewModels';
import { createCanonicalSessionReadModel } from '../src/features/canonical/sessionReadModel';
import { buildParticipantSpaces } from '../src/features/chat/participantSpaces';

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
    title: 'Hi taylor',
    subtitle: 'Hi taylor',
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
      requestText: 'Hi taylor',
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
      text: 'Hi taylor',
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
        requestText: 'Hi taylor',
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
      { id: sessionId, kind: 'direct-person', title: 'Hi taylor', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'human:bob', relationshipIdentityId: 'human:bob', metadata: { source: 'bridge-session-thread', sourceConversationId, sourceHostId: 'host-1', peerNodeId: 'node-bob', peerRuntime: 'person' }, createdAtMs: 2, updatedAtMs: 3, lastMessageAtMs: 3 },
      { id: olderSessionId, kind: 'direct-person', title: 'Earlier unread', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'human:bob', relationshipIdentityId: 'human:bob', metadata: { source: 'bridge-session-thread', sourceConversationId, sourceHostId: 'host-1', peerNodeId: 'node-bob', peerRuntime: 'person' }, createdAtMs: 1, updatedAtMs: 2, lastMessageAtMs: 2 },
    ],
    participants: [
      { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'human:bob', role: 'delegate', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId: olderSessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId: olderSessionId, identityId: 'human:bob', role: 'delegate', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg-hidden', sessionId, senderIdentityId: 'human:bob', senderRole: 'person', messageKind: 'text', contentText: 'Hi taylor', content: { sender: 'Bob', timeLabel: '16:07' }, status: 'delivered', sequenceNum: 1, createdAtMs: 3, updatedAtMs: 3, contentHash: null, sourceTransport: 'desktop-bridge-parent', sourceEventId: 'hidden-1' },
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
