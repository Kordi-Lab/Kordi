import { cloudAccountAvatarFixture } from './helpers/cloudAccountAvatarFixture';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CloudAccount, CloudMessage } from '../src/features/cloud/authClient';
import { buildCloudDesktopCollaborationState, cloudDirectPersonSessionId } from '../src/features/cloud/cloudCollaborationState';
import { encodeCloudAgentResponse } from '../src/features/cloud/cloudAgentMessages';
import { encodeCloudGroupControl } from '../src/features/cloud/cloudGroupMessages';
import { cloudContactToContact } from '../src/features/cloud/useCloudContacts';
import { cloudAccountGenerationKey, cloudCollaborationPreviousStateForContext, suppressCloudCollaborationUnreadCounts } from '../src/features/cloud/useCloudCollaborationState';
import { applyCloudAgentRuntimeRouteToState } from '../src/features/cloud/useCloudCollaborationReadModel';

const account: CloudAccount = {
  accountId: 'acct_me',
  displayName: 'Me Cloud',
  primaryEmail: 'me@example.com',
  avatarUrl: null,
  avatar: cloudAccountAvatarFixture,
  nodeId: 'node_me',
  passwordSet: true,
};

const peer = cloudContactToContact({
  accountId: 'acct_peer',
  displayName: 'Peer Person',
  avatarUrl: null,
  nodeId: 'node_peer',
  createdAt: '2026-05-11T00:00:00Z',
});

const message: CloudMessage = {
  messageId: 'msg_1',
  fromAccountId: 'acct_peer',
  toAccountId: 'acct_me',
  body: 'hello from cloud',
  createdAt: '2026-05-11T10:00:00Z',
  deliveredAt: null,
  readAt: null,
  direction: 'incoming',
};

test('pending unread masks badges while preserving same-account cached transcripts', () => {
  const state = buildCloudDesktopCollaborationState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [message] },
  });
  assert.equal(state.conversations[0]?.unreadCount, 1);

  const currentContextKey = cloudAccountGenerationKey(account.accountId, 3);
  assert.equal(
    cloudCollaborationPreviousStateForContext(state, currentContextKey, currentContextKey),
    state,
  );
  assert.equal(
    cloudCollaborationPreviousStateForContext(
      state,
      currentContextKey,
      cloudAccountGenerationKey('acct_other', 4),
    ),
    null,
  );

  const masked = suppressCloudCollaborationUnreadCounts(state);
  assert.notEqual(masked, state);
  assert.equal(masked?.conversations[0]?.unreadCount, 0);
  assert.equal(masked?.conversations[0]?.messages, state.conversations[0]?.messages);
});

test('unchanged Cloud agent routing preserves collaboration state identity', () => {
  const state = buildCloudDesktopCollaborationState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [message] },
  });
  assert.equal(applyCloudAgentRuntimeRouteToState(state, null), state);

  const route = {
    model: 'openai/gpt-5.6-sol',
    authProvider: 'openai-codex',
    authChoice: 'profile:chatgpt',
    thinking: 'medium',
  };
  const routed = applyCloudAgentRuntimeRouteToState(state, route);
  assert.notEqual(routed, state);
  assert.equal(applyCloudAgentRuntimeRouteToState(routed, route), routed);
});


test('stored self messages restore a private My Kordi cloud agent conversation', () => {
  const selfRequest: CloudMessage = {
    messageId: 'msg_self_request',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_me',
    body: '@Kordi remember this private note',
    createdAt: '2026-05-11T10:00:00Z',
    deliveredAt: '2026-05-11T10:00:00Z',
    readAt: null,
    direction: 'outgoing',
  };
  const selfResponse: CloudMessage = {
    messageId: 'msg_self_response',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_me',
    body: encodeCloudAgentResponse({ requestId: 'msg_self_request', text: 'I will remember it.' }),
    createdAt: '2026-05-11T10:00:01Z',
    deliveredAt: '2026-05-11T10:00:01Z',
    readAt: null,
    direction: 'outgoing',
  };

  const state = buildCloudDesktopCollaborationState({
    account,
    contacts: [],
    messagesByPeer: { acct_me: [selfRequest, selfResponse] },
    activeConversationId: null,
  });

  assert.equal(state.conversations.length, 1);
  assert.equal(state.conversations[0].id, 'cloud:conversation:acct_me:agent');
  assert.equal(state.conversations[0].title, 'My Kordi');
  assert.equal(state.conversations[0].peerRuntime, 'kordi-desktop');
  assert.equal(state.conversations[0].identity.remoteAgentId, 'cloud-local-agent');
  assert.deepEqual(state.conversations[0].messages.map((item) => item.text), [
    '@Kordi remember this private note',
    'I will remember it.',
  ]);
});

test('cloud bridge rebuild reuses unaffected conversation objects by message revision', () => {
  const peerTwo = cloudContactToContact({
    accountId: 'acct_two',
    displayName: 'Second Person',
    avatarUrl: null,
    nodeId: 'node_two',
    createdAt: '2026-05-11T00:00:00Z',
  });
  const secondPeerMessage: CloudMessage = {
    ...message,
    messageId: 'msg_2',
    fromAccountId: 'acct_two',
    body: 'hello from second peer',
  };
  const messagesByPeer = { acct_peer: [message], acct_two: [secondPeerMessage] };
  const first = buildCloudDesktopCollaborationState({ account, contacts: [peer, peerTwo], messagesByPeer });
  const second = buildCloudDesktopCollaborationState({
    account,
    contacts: [peer, peerTwo],
    messagesByPeer,
    previousState: first,
  });

  const firstByPeerId = new Map(first.conversations.map((conversation) => [conversation.peerNodeId, conversation]));
  const secondByPeerId = new Map(second.conversations.map((conversation) => [conversation.peerNodeId, conversation]));
  assert.equal(secondByPeerId.get('acct_peer'), firstByPeerId.get('acct_peer'));
  assert.equal(secondByPeerId.get('acct_two'), firstByPeerId.get('acct_two'));

  const updatedMessagesByPeer = {
    ...messagesByPeer,
    acct_peer: [{ ...message, readAt: '2026-05-11T10:00:01Z' }],
  };
  const third = buildCloudDesktopCollaborationState({
    account,
    contacts: [peer, peerTwo],
    messagesByPeer: updatedMessagesByPeer,
    previousState: second,
  });
  const thirdByPeerId = new Map(third.conversations.map((conversation) => [conversation.peerNodeId, conversation]));
  assert.notEqual(thirdByPeerId.get('acct_peer'), secondByPeerId.get('acct_peer'));
  assert.equal(thirdByPeerId.get('acct_two'), secondByPeerId.get('acct_two'));
});

test('unscoped self-agent cloud cache is hidden when local canonical self-agent history exists', () => {
  const selfRequest: CloudMessage = {
    messageId: 'msg_self_request',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_me',
    body: 'hwllo',
    createdAt: '2026-05-11T10:00:00Z',
    deliveredAt: '2026-05-11T10:00:00Z',
    readAt: null,
    direction: 'outgoing',
  };
  const selfResponse: CloudMessage = {
    messageId: 'msg_self_response',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_me',
    body: encodeCloudAgentResponse({ requestId: 'msg_self_request', text: 'Hello! How can I help?' }),
    createdAt: '2026-05-11T10:00:01Z',
    deliveredAt: '2026-05-11T10:00:01Z',
    readAt: null,
    direction: 'outgoing',
  };

  const state = buildCloudDesktopCollaborationState({
    account,
    contacts: [],
    messagesByPeer: { acct_me: [selfRequest, selfResponse] },
    activeConversationId: null,
    suppressUnscopedSelfAgentConversation: true,
  });

  assert.equal(state.conversations.length, 0);
});

test('cloud contacts and messages become normal desktop collaboration state', () => {
  const state = buildCloudDesktopCollaborationState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [message] },
    activeConversationId: null,
  });

  assert.equal(state.hosts[0].id, 'cloud');
  assert.equal(state.hosts[0].visiblePeers.some((candidate) => candidate.runtime === 'person'), true);
  assert.equal(state.hosts[0].visiblePeers.some((candidate) => candidate.runtime === 'kordi-desktop' && candidate.agentId === 'cloud-agent:acct_peer'), true);
  assert.equal(state.conversations.length, 1);
  assert.equal(state.conversations[0].id, 'cloud:conversation:acct_peer:person');
  assert.equal(state.conversations[0].messages[0].direction, 'inbound');
  assert.equal(state.conversations[0].messages[0].text, 'hello from cloud');
});

test('active empty cloud conversations are materialized for the existing chat UI', () => {
  const state = buildCloudDesktopCollaborationState({
    account,
    contacts: [peer],
    messagesByPeer: {},
    activeConversationId: 'bridge:cloud:acct_peer:person',
  });

  assert.equal(state.conversations.length, 1);
  assert.equal(state.conversations[0].messages.length, 0);
  assert.equal(state.conversations[0].title, 'Peer Person');
});

test('direct Cloud contact conversations do not render group fanout control payloads', () => {
  const directMessage: CloudMessage = {
    ...message,
    messageId: 'msg_direct_visible',
    body: 'direct hello',
    sessionId: 'session:direct-person:acct_me:acct_peer',
    createdAt: '2026-05-11T10:00:00Z',
  };
  const groupFanout: CloudMessage = {
    ...message,
    messageId: 'msg_group_fanout_hidden',
    body: encodeCloudGroupControl({
      kind: 'group-message',
      groupId: 'session:group:team',
      groupTitle: 'Team',
      createdByAccountId: 'acct_peer',
      actor: { accountId: 'acct_peer', displayName: 'Peer Person', avatarUrl: null, role: 'person' },
      participants: [
        { accountId: 'acct_me', displayName: 'Me Cloud', avatarUrl: null, role: 'person' },
        { accountId: 'acct_peer', displayName: 'Peer Person', avatarUrl: null, role: 'person' },
      ],
      message: {
        id: 'msg_group_inner',
        senderAccountId: 'acct_peer',
        text: '@KordiProjectDriver hi',
        createdAtMs: Date.parse('2026-05-11T10:01:00Z'),
        senderKind: 'human',
      },
    }),
    sessionId: 'session:group:team',
    createdAt: '2026-05-11T10:01:00Z',
  };
  const malformedGroupFanout: CloudMessage = {
    ...message,
    messageId: 'msg_group_fanout_malformed_hidden',
    body: 'kordi-cloud-group:stale-or-truncated-payload',
    sessionId: 'session:group:team',
    createdAt: '2026-05-11T10:02:00Z',
  };

  const state = buildCloudDesktopCollaborationState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [directMessage, groupFanout, malformedGroupFanout] },
    activeConversationId: 'bridge:cloud:acct_peer:person',
  });

  assert.equal(state.conversations.length, 1);
  assert.deepEqual(state.conversations[0].messages.map((item) => item.text), ['direct hello']);
  assert.equal(state.conversations[0].messages.some((item) => item.text.startsWith('kordi-cloud-group:')), false);
});

test('active cloud conversations clear unread while inactive conversations keep unread', () => {
  const activeState = buildCloudDesktopCollaborationState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [message] },
    activeConversationId: 'bridge:cloud:acct_peer:person',
  });
  const inactiveState = buildCloudDesktopCollaborationState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [message] },
    activeConversationId: null,
  });

  assert.equal(activeState.conversations[0].unreadCount, 0);
  assert.equal(inactiveState.conversations[0].unreadCount, 1);
});

test('cloud read markers keep previously read inbound messages from becoming unread again', () => {
  const state = buildCloudDesktopCollaborationState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [message] },
    readInboundMessageIdsByPeer: { acct_peer: new Set(['msg_1']) },
    activeConversationId: null,
  });

  assert.equal(state.conversations[0].unreadCount, 0);
});

test('cloud direct unread honors canonical direct-session read cursor when cached readAt is stale', () => {
  const directSessionId = cloudDirectPersonSessionId(account.accountId, 'acct_peer');
  const staleCachedInbound: CloudMessage = {
    ...message,
    messageId: 'cloud_stale_unread_after_cursor',
    sessionId: directSessionId,
    createdAt: '2026-05-11T10:00:00Z',
    readAt: null,
  };
  const state = buildCloudDesktopCollaborationState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [staleCachedInbound] },
    readCursorsBySessionId: {
      [directSessionId]: { lastReadMessageId: 'msg:canonical-latest', lastReadCreatedAtMs: Date.parse('2026-05-11T10:00:01Z') },
    },
    activeConversationId: null,
  });

  assert.equal(state.conversations[0].unreadCount, 0);
});

test('cloud self-authored human messages never count as unread badges', () => {
  const selfMessage: CloudMessage = {
    ...message,
    messageId: 'msg_self_agent_unread_candidate',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_me',
    body: 'private prompt',
    direction: 'outgoing',
    readAt: null,
    sessionId: 'f51f7d19-8c8f-4228-9cdd-074ae9b2146e',
  };
  const state = buildCloudDesktopCollaborationState({
    account,
    contacts: [],
    messagesByPeer: { acct_me: [selfMessage] },
    activeConversationId: null,
  });

  assert.equal(state.conversations.length, 1);
  assert.equal(state.conversations[0].canonicalSessionId, 'f51f7d19-8c8f-4228-9cdd-074ae9b2146e');
  assert.equal(state.conversations[0].unreadCount, 0);
});

test('cloud self-agent responses count as unread until the canonical cursor advances', () => {
  const sessionId = 'f51f7d19-8c8f-4228-9cdd-074ae9b2146e';
  const selfAgentResponse: CloudMessage = {
    ...message,
    messageId: 'msg_self_agent_response',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_me',
    body: encodeCloudAgentResponse({ requestId: 'msg_self_agent_request', text: 'Finished.' }),
    direction: 'outgoing',
    readAt: null,
    sessionId,
  };
  const unread = buildCloudDesktopCollaborationState({
    account,
    contacts: [],
    messagesByPeer: { acct_me: [selfAgentResponse] },
    activeConversationId: null,
  });
  const read = buildCloudDesktopCollaborationState({
    account,
    contacts: [],
    messagesByPeer: { acct_me: [selfAgentResponse] },
    readCursorsBySessionId: {
      [sessionId]: {
        lastReadMessageId: selfAgentResponse.messageId,
        lastReadCreatedAtMs: Date.parse(selfAgentResponse.createdAt),
      },
    },
    activeConversationId: null,
  });

  assert.equal(unread.conversations[0].unreadCount, 1);
  assert.equal(read.conversations[0].unreadCount, 0);
});

test('cloud inbound messages with server read_at do not become unread after relaunch', () => {
  const readInbound: CloudMessage = {
    ...message,
    messageId: 'msg_inbound_read_on_server',
    fromAccountId: 'acct_peer',
    toAccountId: 'acct_me',
    body: 'already read',
    direction: 'incoming',
    readAt: '2026-05-11T12:00:00Z',
  };
  const state = buildCloudDesktopCollaborationState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [readInbound] },
    readInboundMessageIdsByPeer: {},
    activeConversationId: null,
  });

  assert.equal(state.conversations[0].unreadCount, 0);
});

test('cloud outgoing messages render as delivered once accepted by the cloud server', () => {
  const outgoing: CloudMessage = {
    ...message,
    messageId: 'msg_outgoing',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    body: 'hi',
    direction: 'outgoing',
  };
  const state = buildCloudDesktopCollaborationState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [outgoing] },
    activeConversationId: 'bridge:cloud:acct_peer:person',
  });

  assert.equal(state.conversations[0].messages[0].deliveryState, 'delivered');
});
