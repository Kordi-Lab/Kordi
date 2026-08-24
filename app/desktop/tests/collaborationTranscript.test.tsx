import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mapCollaborationConversationToViewModel } from '../src/features/collaboration/transcript';
import type { DesktopCollaborationConversation, DesktopCollaborationHost } from '../src/kordi-app/types';

function host(overrides: Partial<DesktopCollaborationHost> = {}): DesktopCollaborationHost {
  return {
    id: 'host-1',
    registered: true,
    connected: true,
    serverUrl: 'https://bridge.test',
    nodeId: 'node-me',
    displayName: 'My Kordi',
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
    ...overrides,
  };
}

function conversation(overrides: Partial<DesktopCollaborationConversation> = {}): DesktopCollaborationConversation {
  return {
    id: 'bridge:host-1:node-peer:person',
    canonicalSessionId: 'session:bridge:humans:peer',
    hostId: 'host-1',
    peerNodeId: 'node-peer',
    peerDisplayName: 'Ethan',
    peerOwnerName: 'Ethan',
    peerRuntime: 'person',
    projectId: null,
    projectName: null,
    title: 'Ethan',
    subtitle: 'hi',
    unreadCount: 0,
    updatedAtMs: 1,
    updatedAtLabel: '16:39',
    awaitingReply: false,
    peerTyping: false,
    peerLastHeartbeatLabel: null,
    outreach: null,
    identity: null,
    messages: [],
    ...overrides,
  };
}

test('unread structured person mentions surface attention without matching forwarded quotes', () => {
  const identity = {
    sourceHostId: 'cloud',
    localHumanId: 'acct_me',
    localHumanName: 'Me',
    localAgentId: 'cloud-local-agent',
    localAgentName: 'My Kordi',
    localAgentNodeId: 'acct_me',
    remoteHumanId: 'acct_peer',
    remoteHumanName: 'Peer',
  };
  const mention = { label: 'Me', targetKind: 'person', targetIdentityId: 'human:acct_me', humanId: 'acct_me' };
  const view = mapCollaborationConversationToViewModel(conversation({
    unreadCount: 2,
    identity,
    messages: [
      { id: 'read-mention', direction: 'inbound', text: '@Me old', timeLabel: '09:00', timestampMs: 1, mentions: [mention] },
      { id: 'forwarded-mention', direction: 'inbound', text: '@Me quoted', timeLabel: '09:01', timestampMs: 2, mentions: [mention], messageAction: { schemaVersion: 1, kind: 'forward', source: { sourceSessionId: 'source', sourceMessageId: 'message', senderLabel: 'Peer', textPreview: '@Me quoted', attachmentCount: 0 } } },
      { id: 'unread-mention', direction: 'inbound', text: '@Me new', timeLabel: '09:02', timestampMs: 3, mentions: [mention] },
    ],
  }), host());

  assert.equal(view.unreadMentions, 1);
});

test('cloud self-agent bridge conversations render as My agent, not external agent', () => {
  const view = mapCollaborationConversationToViewModel(conversation({
    id: 'bridge:cloud:acct_me',
    canonicalSessionId: 'bridge:cloud:acct_me',
    hostId: 'cloud',
    peerNodeId: 'acct_me',
    peerDisplayName: 'My Kordi',
    peerOwnerName: 'Me',
    peerRuntime: 'kordi-desktop',
    title: 'My Kordi',
    subtitle: 'Hello!',
    identity: {
      sourceHostId: 'cloud',
      localHumanId: 'acct_me',
      localHumanName: 'Me',
      localAgentId: 'cloud-local-agent',
      localAgentName: 'My Kordi',
      localAgentNodeId: 'acct_me',
      remoteHumanId: 'acct_me',
      remoteHumanName: 'Me',
      remoteHumanNodeId: 'acct_me',
      remoteAgentId: 'cloud-local-agent',
      remoteAgentName: 'My Kordi',
      remoteAgentNodeId: 'acct_me',
      remoteAgentRuntime: 'kordi-desktop',
    },
    messages: [{
      id: 'msg-response',
      direction: 'outbound-response',
      sender: 'My Kordi',
      text: 'Hello!',
      timeLabel: '09:57',
      timestampMs: 2,
    }],
  }), host({
    id: 'cloud',
    serverUrl: 'kordi.cloud',
    nodeId: 'acct_me',
    humanId: 'acct_me',
    displayName: 'Kordi Cloud',
    ownerName: 'Me',
  }), 'My Kordi');

  assert.equal(view.type, 'owned-agent');
  assert.equal(view.directness, 'Agent chat');
  assert.deepEqual(view.participants, ['Me', 'My Kordi']);
  assert.equal(view.messages[0]?.role, 'owned-agent');
  assert.equal(view.messages[0]?.sender, 'My Kordi');
  assert.equal(view.messages[0]?.timestampMs, 2);
});
test('bridge transcript maps local and remote human profile images onto message avatars', () => {
  const view = mapCollaborationConversationToViewModel(conversation({
    messages: [
      {
        id: 'msg-outbound',
        direction: 'outbound',
        sender: 'Me',
        text: 'hello',
        timeLabel: '09:56',
        timestampMs: 1,
      },
      {
        id: 'msg-inbound',
        direction: 'inbound',
        sender: 'Ethan',
        text: 'hi',
        timeLabel: '09:57',
        timestampMs: 2,
      },
    ],
  }), host({
    profileImageUrl: 'https://images.test/me.png',
    visiblePeers: [{
      nodeId: 'node-peer',
      displayName: 'Ethan',
      runtime: 'person',
      endpoint: 'https://bridge.test',
      ownerName: 'Ethan',
      createdAt: null,
      sharedProjects: [],
      humanId: 'human-peer',
      agentId: null,
      profileImageUrl: 'https://images.test/peer.png',
      avatarSeed: 'peer-seed',
    }],
    visiblePeerCount: 1,
  }), 'My Kordi');

  assert.equal(view.messages[0]?.senderProfileImageUrl, 'https://images.test/me.png');
  assert.equal(view.messages[1]?.senderProfileImageUrl, 'https://images.test/peer.png');
  assert.equal(view.participantProfileImageUrls?.Me, 'https://images.test/me.png');
  assert.equal(view.participantProfileImageUrls?.Ethan, 'https://images.test/peer.png');
});

test('bridge transcript keeps implicit direct person session messages as typed', () => {
  const requestId = 'bridge_req_direct';
  const view = mapCollaborationConversationToViewModel(conversation({
    messages: [{
      id: 'msg-direct',
      direction: 'outbound',
      sender: 'Me',
      text: 'hello',
      timeLabel: '17:01',
      timestampMs: 1,
      requestId,
      deliveryState: 'read',
      outreach: {
        targetKind: 'person',
        parentSessionId: 'd17bf74f-f065-46cb-82d7-bf78ed7f910f',
        sourceHostId: 'host-1',
        sourceConversationId: 'bridge:host-1:node-peer:person',
        sourceRequestId: requestId,
        targetNodeId: 'node-peer',
        targetDisplayName: "Ethan's Kordi",
        targetOwnerName: 'Ethan',
        targetRuntime: 'person',
        requestText: 'hello',
        triggerText: null,
        contextText: null,
        contextPolicy: 'session-message',
        status: 'completed',
        createdAtMs: 1,
        updatedAtMs: 1,
      },
    }],
  }), host(), 'My Kordi');

  assert.equal(view.messages[0]?.text, 'hello');
  assert.equal(view.messages[0]?.mentions, undefined);
});

test('direct person bridge transcript hides group relay agent placeholders', () => {
  const view = mapCollaborationConversationToViewModel(conversation({
    messages: [{
      id: 'msg-direct-human',
      direction: 'outbound',
      sender: 'Me',
      text: 'helllo',
      timeLabel: '22:59',
      timestampMs: 1,
      requestId: 'bridge_req_direct',
      deliveryState: 'read',
      outreach: {
        targetKind: 'person',
        parentSessionId: 'session:bridge:humans:peer',
        sourceHostId: 'host-1',
        sourceConversationId: 'bridge:host-1:node-peer:person',
        sourceRequestId: 'bridge_req_direct',
        targetNodeId: 'node-peer',
        targetDisplayName: 'Ethan',
        targetOwnerName: 'Ethan',
        targetRuntime: 'person',
        requestText: 'helllo',
        contextText: null,
        contextPolicy: 'session-message',
        status: 'completed',
        createdAtMs: 1,
        updatedAtMs: 1,
      },
    }, {
      id: 'msg-group-agent-processing',
      direction: 'inbound-response',
      sender: "Ethan's Kordi",
      text: 'processing...',
      timeLabel: '23:19',
      timestampMs: 2,
      requestId: 'bridge_req_group_agent',
      deliveryState: 'processing',
      outreach: {
        targetKind: 'person',
        parentSessionId: 'session:group:shared',
        parentSessionKind: 'group',
        parentGroupSpaceId: 'session:group:shared',
        sourceHostId: 'host-1',
        sourceConversationId: 'bridge:host-1:node-peer:person',
        sourceRequestId: 'bridge_req_group_agent',
        targetNodeId: 'node-peer',
        targetDisplayName: 'Ethan',
        targetOwnerName: 'Ethan',
        targetRuntime: 'person',
        requestText: 'processing...',
        contextText: null,
        contextPolicy: 'session-relay',
        status: 'completed',
        createdAtMs: 2,
        updatedAtMs: 2,
      },
    }],
  }), host(), 'My Kordi');

  assert.deepEqual(view.messages.map((message) => message.turn?.message ?? message.text), ['helllo']);
});

test('bridge transcript excludes hidden group invites from scoped unread badges', () => {
  const groupSessionId = 'session:group:unread';
  const view = mapCollaborationConversationToViewModel(conversation({
    canonicalSessionId: 'session:bridge:humans:peer',
    unreadCount: 2,
    messages: [{
      id: 'msg-earlier-visible',
      direction: 'inbound',
      sender: 'Ethan',
      text: 'earlier visible group message',
      timeLabel: '16:35',
      timestampMs: 1,
      requestId: 'bridge_req_earlier_visible',
      deliveryState: null,
      outreach: {
        targetKind: 'person',
        parentSessionId: groupSessionId,
        sourceHostId: 'host-1',
        sourceConversationId: 'bridge:host-1:node-peer:person',
        sourceRequestId: 'bridge_req_earlier_visible',
        targetNodeId: 'node-peer',
        targetDisplayName: 'Ethan',
        targetOwnerName: 'Ethan',
        targetRuntime: 'person',
        requestText: 'earlier visible group message',
        triggerText: null,
        contextText: null,
        contextPolicy: 'session-message',
        status: 'completed',
        createdAtMs: 1,
        updatedAtMs: 1,
      },
    }, {
      id: 'msg-group-invite',
      direction: 'inbound',
      sender: 'Ethan',
      text: 'You were added to testgroup',
      timeLabel: '16:36',
      timestampMs: 2,
      requestId: 'bridge_req_group_invite',
      deliveryState: null,
      outreach: {
        targetKind: 'person',
        parentSessionId: groupSessionId,
        sourceHostId: 'host-1',
        sourceConversationId: 'bridge:host-1:node-peer:person',
        sourceRequestId: 'bridge_req_group_invite',
        targetNodeId: 'node-peer',
        targetDisplayName: 'Ethan',
        targetOwnerName: 'Ethan',
        targetRuntime: 'person',
        requestText: 'You were added to testgroup',
        triggerText: null,
        contextText: null,
        contextPolicy: 'session-invite',
        status: 'completed',
        createdAtMs: 2,
        updatedAtMs: 2,
      },
    }, {
      id: 'msg-visible-group-message',
      direction: 'inbound',
      sender: 'Ethan',
      text: 'hello every one',
      timeLabel: '16:37',
      timestampMs: 3,
      requestId: 'bridge_req_visible_group_message',
      deliveryState: null,
      outreach: {
        targetKind: 'person',
        parentSessionId: groupSessionId,
        sourceHostId: 'host-1',
        sourceConversationId: 'bridge:host-1:node-peer:person',
        sourceRequestId: 'bridge_req_visible_group_message',
        targetNodeId: 'node-peer',
        targetDisplayName: 'Ethan',
        targetOwnerName: 'Ethan',
        targetRuntime: 'person',
        requestText: 'hello every one',
        triggerText: null,
        contextText: null,
        contextPolicy: 'session-message',
        status: 'completed',
        createdAtMs: 3,
        updatedAtMs: 3,
      },
    }],
  }), host(), 'My Kordi');

  assert.deepEqual(view.collaborationUnreadByParentSessionId, { [groupSessionId]: 1 });
});

test('bridge transcript carries message attachments into the view model', () => {
  const view = mapCollaborationConversationToViewModel(conversation({
    messages: [{
      id: 'msg-attachment',
      direction: 'outbound',
      sender: 'Me',
      text: 'see screenshot',
      timeLabel: '17:02',
      timestampMs: 1,
      requestId: 'bridge_req_attachment',
      deliveryState: 'sent',
      attachments: [{
        kind: 'image',
        name: 'screenshot.png',
        formatLabel: 'PNG',
        mimeType: 'image/png',
      }],
    } as never],
  }), host(), 'My Kordi');

  assert.deepEqual(view.messages[0]?.attachments, [{
    kind: 'image',
    name: 'screenshot.png',
    formatLabel: 'PNG',
    mimeType: 'image/png',
  }]);
});

test('direct person bridge transcript rewrites remote first-person agent mentions for display', () => {
  const view = mapCollaborationConversationToViewModel(conversation({
    messages: [{
      id: 'msg-remote-local-agent-mention',
      direction: 'inbound',
      sender: 'Ethan',
      text: '@MyKordi show me the diskusage',
      timeLabel: '17:30',
      timestampMs: 1,
      requestId: 'bridge_req_local_agent',
      deliveryState: null,
      outreach: {
        targetKind: 'person',
        parentSessionId: 'd17bf74f-f065-46cb-82d7-bf78ed7f910f',
        sourceHostId: 'host-1',
        sourceConversationId: 'bridge:host-1:node-peer:person',
        sourceRequestId: 'bridge_req_local_agent',
        targetNodeId: 'node-peer',
        targetDisplayName: 'Me',
        targetOwnerName: 'Me',
        targetRuntime: 'person',
        requestText: '@MyKordi show me the diskusage',
        triggerText: '@MyKordi show me the diskusage',
        contextText: null,
        contextPolicy: 'session-relay',
        status: 'completed',
        createdAtMs: 1,
        updatedAtMs: 1,
      },
    }],
  }), host(), 'My Kordi');

  assert.equal(view.messages[0]?.text, '@EthansKordi show me the diskusage');
});

test('direct person bridge transcript renders local agent responses as agent turns', () => {
  const view = mapCollaborationConversationToViewModel(conversation({
    messages: [{
      id: 'msg-local-agent-response',
      direction: 'outbound-response',
      sender: "Alex's Kordi",
      text: 'We were talking about San Diego weather.',
      timeLabel: '17:07',
      timestampMs: 2,
      requestId: 'bridge_req_agent',
      deliveryState: 'responded',
      outreach: null,
    }],
  }), host(), 'My Kordi');

  const message = view.messages[0];
  assert.equal(message?.role, 'owned-agent');
  assert.equal(message?.senderType, 'agent');
  assert.equal(message?.sender, "Alex's Kordi");
  assert.equal(message?.text, '');
  assert.equal(message?.turn?.assistantText, 'We were talking about San Diego weather.');
  assert.deepEqual(message?.turn?.tools, []);
});

test('direct person bridge transcript renders remote agent responses as agent turns', () => {
  const view = mapCollaborationConversationToViewModel(conversation({
    messages: [{
      id: 'msg-remote-agent-response',
      direction: 'inbound-response',
      sender: "Ethan's Kordi",
      text: 'The answer is ready.',
      timeLabel: '17:08',
      timestampMs: 2,
      requestId: 'bridge_req_remote_agent',
      deliveryState: 'responded',
      outreach: null,
    }],
  }), host(), 'My Kordi');

  const message = view.messages[0];
  assert.equal(message?.role, 'external-agent');
  assert.equal(message?.senderType, 'agent');
  assert.equal(message?.sender, "Ethan's Kordi");
  assert.equal(message?.text, '');
  assert.equal(message?.turn?.assistantText, 'The answer is ready.');
  assert.deepEqual(message?.turn?.tools, []);
});

test('direct person bridge transcript hides historical processing placeholders after newer messages', () => {
  const view = mapCollaborationConversationToViewModel(conversation({
    messages: [{
      id: 'msg-user-asked-agent',
      direction: 'outbound',
      sender: 'Me',
      text: '@MyKordi summarize PR 201',
      timeLabel: '17:08',
      timestampMs: 1,
      requestId: 'bridge_req_user_ask',
      deliveryState: 'sent',
      outreach: null,
    }, {
      id: 'msg-stale-processing',
      direction: 'outbound-response',
      sender: "Me's Kordi",
      text: 'processing...',
      timeLabel: '17:08',
      timestampMs: 2,
      requestId: 'bridge_req_processing',
      deliveryState: 'processing',
      outreach: null,
    }, {
      id: 'msg-later-human-message',
      direction: 'inbound',
      sender: 'Ethan',
      text: 'thanks',
      timeLabel: '17:09',
      timestampMs: 3,
      requestId: 'bridge_req_later',
      deliveryState: null,
      outreach: null,
    }],
  }), host(), 'My Kordi');

  assert.equal(view.messages.some((message) => message.turn?.status === 'processing'), false);
  assert.deepEqual(view.messages.map((message) => message.turn?.id ?? message.text), [
    '@MyKordi summarize PR 201',
    'thanks',
  ]);
});

test('bridge transcript renders cancelled bridge agent requests as stopped instead of processing', () => {
  const requestId = 'bridge_req_cancelled';
  const view = mapCollaborationConversationToViewModel(conversation({
    id: 'bridge:host-1:node-peer',
    canonicalSessionId: 'session:bridge:agents:peer',
    peerDisplayName: "Maya's Kordi",
    peerOwnerName: 'Maya',
    peerRuntime: 'kordi-desktop',
    title: "Maya's Kordi",
    awaitingReply: true,
    outreach: {
      targetKind: 'agent',
      parentSessionId: 'session:group:shared',
      sourceHostId: 'host-1',
      sourceConversationId: 'bridge:host-1:node-peer',
      sourceRequestId: requestId,
      targetNodeId: 'node-peer',
      targetDisplayName: "Maya's Kordi",
      targetOwnerName: 'Maya',
      targetRuntime: 'kordi-desktop',
      requestText: 'test test',
      triggerText: '@MayasKordi test test',
      contextText: null,
      contextPolicy: 'recent-window',
      status: 'cancelled',
      deliveryState: 'cancelled',
      createdAtMs: 1,
      updatedAtMs: 2,
    },
    messages: [{
      id: 'msg-cancelled-request',
      direction: 'outbound',
      sender: 'Me',
      text: 'test test',
      timeLabel: '17:08',
      timestampMs: 1,
      requestId,
      deliveryState: 'cancelled',
      outreach: null,
    }],
  }), host(), 'My Kordi');

  assert.equal(view.messages.some((message) => message.turn?.status === 'processing'), false);
  const stoppedTurn = view.messages.find((message) => message.turn?.status === 'cancelled')?.turn;
  assert.equal(stoppedTurn?.completed, true);
  assert.equal(stoppedTurn?.assistantText, 'Request stopped');
});

test('bridge transcript does not show processing for unsent agent outreach', () => {
  const view = mapCollaborationConversationToViewModel(conversation({
    peerRuntime: 'kordi-desktop',
    awaitingReply: true,
    outreach: {
      targetKind: 'agent',
      parentSessionId: 'session:direct-agent:peer',
      sourceHostId: 'host-1',
      sourceConversationId: 'bridge:host-1:node-peer:kordi-desktop',
      sourceRequestId: null,
      targetNodeId: 'node-peer',
      targetDisplayName: "Ethan's Kordi",
      targetOwnerName: 'Ethan',
      targetRuntime: 'kordi-desktop',
      requestText: 'hello',
      status: 'awaitingReply',
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    messages: [],
  }), host(), 'My Kordi');

  assert.equal(view.messages.some((message) => message.turn?.status === 'processing'), false);
});

test('bridge transcript preserves full outreach mention labels with spaces and punctuation', () => {
  const requestId = 'bridge_req_mention';
  const view = mapCollaborationConversationToViewModel(conversation({
    outreach: {
      targetKind: 'agent',
      parentSessionId: 'session:bridge:humans:peer',
      sourceHostId: 'host-1',
      sourceConversationId: 'bridge:host-1:node-peer:person',
      sourceRequestId: requestId,
      targetNodeId: 'node-agent',
      targetDisplayName: "Ethan's Kordi",
      targetOwnerName: 'Ethan',
      targetRuntime: 'kordi-desktop',
      requestText: 'hi',
      status: 'completed',
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    messages: [{
      id: 'msg-1',
      direction: 'outbound',
      sender: 'Me',
      text: 'hi',
      timeLabel: '16:39',
      timestampMs: 1,
      requestId,
      deliveryState: 'read',
      outreach: null,
    }],
  }), host(), 'My Kordi');

  assert.equal(view.messages[0]?.text, "@Ethan's Kordi hi");
  assert.deepEqual(view.messages[0]?.mentions?.map((mention) => mention.label), ["Ethan's Kordi"]);
});
