import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CloudAccount, CloudMessage } from '../src/features/cloud/authClient';
import {
  buildCloudDesktopBridgeState,
  cloudBridgeConversationId,
  cloudDirectPersonSessionId,
  cloudContactsToCanonicalIdentityRequests,
  cloudGroupParticipantContacts,
  cloudMessageToBridgeMessage,
  cloudPeerAccountIdFromConversationId,
  isCloudBridgeConversationId,
} from '../src/features/cloud/cloudBridgeState';
import { mapBridgeConversationToViewModel } from '../src/features/bridge/transcript';
import { encodeCloudAgentCancel, encodeCloudAgentResponse } from '../src/features/cloud/cloudAgentMessages';
import { cloudGroupForkPayloadFromSessionMetadata, cloudGroupParticipantsWithProfiles, encodeCloudGroupControl } from '../src/features/cloud/cloudGroupMessages';
import { cloudContactToContact } from '../src/features/cloud/useCloudContacts';
import {
  cloudAgentMentionCandidates,
  cloudBootstrapPeerIds,
  cloudGroupAgentCancelRoleForRequest,
  cloudGroupAgentCancelledNoticeRequest,
  cloudGroupAgentProcessingMessageForRequest,
  cloudGroupAgentProcessingSlotForResponse,
  optimisticCloudAgentCancelMessage,
  planCloudSelfAgentSync,
  cloudMessagesByPeerEqual,
  mergeCloudMessagesByPeerSnapshot,
  loadCloudMessagesByPeerUntilStable,
  cloudInitialMessagesSettledForPeerKey,
  cachedCloudMessagesByPeerHasMessages,
  loadCachedCloudMessagesByPeer,
  saveCachedCloudMessagesByPeer,
} from '../src/features/cloud/useCloudBridgeState';
import type { CanonicalSessionMessage, CanonicalSessionState } from '../src/kordi-app/types';

const account: CloudAccount = {
  accountId: 'acct_me',
  displayName: 'Me Cloud',
  primaryEmail: 'me@example.com',
  avatarUrl: null,
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

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => { values.delete(key); },
    setItem: (key: string, value: string) => { values.set(key, String(value)); },
  };
}

test('cloud message local cache round-trips all peer chat messages', () => {
  const storage = memoryStorage();
  saveCachedCloudMessagesByPeer('acct_me', {
    acct_peer: [message],
    acct_group_peer: [{ ...message, messageId: 'msg_group_1', fromAccountId: 'acct_group_peer' }],
  }, storage);

  assert.equal(cachedCloudMessagesByPeerHasMessages('acct_me', storage), true);
  assert.deepEqual(loadCachedCloudMessagesByPeer('acct_me', storage), {
    acct_peer: [message],
    acct_group_peer: [{ ...message, messageId: 'msg_group_1', fromAccountId: 'acct_group_peer' }],
  });
});

test('cloud message local cache ignores malformed cached records', () => {
  const storage = memoryStorage();
  storage.setItem('kordi.cloud.messagesByPeer.v1:acct_me', JSON.stringify({
    acct_peer: [{ messageId: '', fromAccountId: 'acct_peer' }, message],
  }));

  assert.deepEqual(loadCachedCloudMessagesByPeer('acct_me', storage), { acct_peer: [message] });
});

test('cloud message refresh snapshots preserve locally merged newer messages', () => {
  const greeting: CloudMessage = {
    ...message,
    messageId: 'msg_hello',
    body: 'hello',
    createdAt: '2026-05-11T10:00:00Z',
  };
  const justSent: CloudMessage = {
    ...message,
    messageId: 'msg_sent',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    direction: 'outgoing',
    body: 'hiho w are you',
    createdAt: '2026-05-11T10:00:05Z',
    deliveredAt: '2026-05-11T10:00:05Z',
    sessionId: 'session:direct-person:acct_me:acct_peer',
  };

  const merged = mergeCloudMessagesByPeerSnapshot(
    { acct_peer: [greeting, justSent] },
    { acct_peer: [greeting] },
  );

  assert.deepEqual(merged.acct_peer?.map((item) => item.messageId), ['msg_hello', 'msg_sent']);
});

test('cloud message peer equality detects attachment cache updates', () => {
  const baseMessage: CloudMessage = {
    ...message,
    attachments: [{
      attachmentId: 'att_1',
      name: 'Screenshot.png',
      kind: 'image',
      mimeType: 'image/png',
      sizeBytes: 68 * 1024,
      localPath: null,
    }],
  };

  assert.equal(cloudMessagesByPeerEqual({ acct_peer: [baseMessage] }, {
    acct_peer: [{
      ...baseMessage,
      attachments: [{
        ...baseMessage.attachments![0]!,
        localPath: '/tmp/kordi-cache/Screenshot.png',
      }],
    }],
  }), false);
});

test('cloud bridge messages preserve resolved attachment local paths for inline previews', () => {
  const mapped = cloudMessageToBridgeMessage(account, {
    ...message,
    attachments: [{
      attachmentId: 'att_1',
      name: 'Screenshot.png',
      kind: 'image',
      mimeType: 'image/png',
      sizeBytes: 68 * 1024,
      localPath: '/tmp/kordi-cache/Screenshot.png',
    }],
  }, peer);

  assert.equal(mapped.attachments?.[0]?.attachmentId, 'att_1');
  assert.equal(mapped.attachments?.[0]?.localPath, '/tmp/kordi-cache/Screenshot.png');
});

test('direct Cloud contact agent mentions are not treated as Cloud group placeholders', () => {
  const state = {
    profile: { humanIdentityId: 'human:me', displayName: 'Me' },
    sessions: [],
    identities: [
      { id: 'human:peer', kind: 'human', displayName: 'Peer Person', source: 'bridge', bridgeNodeId: 'acct_peer', humanId: 'acct_peer', ownerIdentityId: null, sourceHostId: 'cloud', agentId: null, avatarKey: 'peer', profileImageUrl: null, metadata: null, createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:cloud:acct_peer', kind: 'agent', displayName: "Peer Person's Kordi", source: 'bridge', bridgeNodeId: 'cloud-agent:acct_peer', humanId: 'acct_peer', ownerIdentityId: 'human:peer', sourceHostId: 'cloud', agentId: 'cloud-agent:acct_peer', avatarKey: 'peer-agent', profileImageUrl: null, metadata: null, createdAtMs: 1, updatedAtMs: 1 },
    ],
    participants: [],
    messages: [{
      id: 'msg_direct_request',
      sessionId: 'session:direct-person:acct_me:acct_peer',
      senderIdentityId: 'human:me',
      senderRole: 'user',
      messageKind: 'text',
      contentText: '@PeerKordi hi',
      content: { mentions: [{ targetKind: 'bridge-agent', bridgeHostId: 'cloud', humanId: 'acct_peer', label: "Peer's Kordi" }] },
      parentMessageId: null,
      delegatedExchangeId: null,
      status: 'sent',
      sequenceNum: 1,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      contentHash: null,
      sourceTransport: 'cloud-direct',
      sourceEventId: 'cloud-direct:msg_direct_request',
    }],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
    storagePath: null,
  } satisfies CanonicalSessionState;

  assert.deepEqual(cloudAgentMentionCandidates(state, 'acct_me'), []);
});

test('cloud group agent mention candidates ignore inherited fork snapshot rows', () => {
  const state = {
    profile: { humanIdentityId: 'human:me', displayName: 'Me' },
    sessions: [],
    identities: [
      { id: 'human:peer', kind: 'human', displayName: 'Peer Person', source: 'bridge', bridgeNodeId: 'acct_peer', humanId: 'acct_peer', ownerIdentityId: null, sourceHostId: 'cloud', agentId: null, avatarKey: 'peer', profileImageUrl: null, metadata: null, createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:cloud:acct_peer', kind: 'agent', displayName: "Peer Person's Kordi", source: 'bridge', bridgeNodeId: 'cloud-agent:acct_peer', humanId: 'acct_peer', ownerIdentityId: 'human:peer', sourceHostId: 'cloud', agentId: 'cloud-agent:acct_peer', avatarKey: 'peer-agent', profileImageUrl: null, metadata: null, createdAtMs: 1, updatedAtMs: 1 },
    ],
    participants: [],
    messages: [{
      id: 'msg_snapshot_request',
      sessionId: 'session:fork:abc',
      senderIdentityId: 'human:me',
      senderRole: 'user',
      messageKind: 'text',
      contentText: '@PeerPersonKordi hello',
      content: { mentions: [{ targetKind: 'bridge-agent', bridgeHostId: 'cloud', humanId: 'acct_peer', label: "PeerPerson's Kordi" }] },
      parentMessageId: null,
      delegatedExchangeId: null,
      status: 'sent',
      sequenceNum: 1,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      contentHash: null,
      sourceTransport: 'canonical-fork-snapshot',
      sourceEventId: 'fork-snapshot:msg_snapshot_request',
    }],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
    storagePath: null,
  } satisfies CanonicalSessionState;

  assert.deepEqual(cloudAgentMentionCandidates(state, 'acct_me'), []);
});

test('cloud group fork payload is recovered from canonical fork metadata', () => {
  assert.deepEqual(cloudGroupForkPayloadFromSessionMetadata({
    fork: {
      forkedFromSessionId: 'session:group:source',
      forkedFromMessageId: 'msg:source',
      createdAtMs: 1234,
    },
  }, 'session:fork:abc'), {
    forkSessionId: 'session:fork:abc',
    parentSessionId: 'session:group:source',
    parentMessageId: 'msg:source',
    createdAtMs: 1234,
  });
});

test('cloud bridge conversation ids use normal bridge ids with cloud host sentinel', () => {
  assert.equal(cloudBridgeConversationId('acct_peer'), 'bridge:cloud:acct_peer:person');
  assert.equal(cloudBridgeConversationId('acct_peer', 'kordi-desktop'), 'bridge:cloud:acct_peer');
  assert.equal(cloudDirectPersonSessionId('acct_me', 'acct_peer'), 'session:direct-person:acct_me:acct_peer');
  assert.equal(cloudDirectPersonSessionId('acct_peer', 'acct_me'), 'session:direct-person:acct_me:acct_peer');
  assert.equal(cloudPeerAccountIdFromConversationId('bridge:cloud:acct_peer:person'), 'acct_peer');
  assert.equal(cloudPeerAccountIdFromConversationId('bridge:cloud:acct_peer'), 'acct_peer');
  assert.equal(isCloudBridgeConversationId('bridge:local:node:person'), false);
});

test('cloud self-agent bridge state preserves one Cloud conversation per local session id', () => {
  const cloudMessages = [
    {
      ...message,
      messageId: 'msg_s1_u1',
      fromAccountId: 'acct_me',
      toAccountId: 'acct_me',
      direction: 'outgoing',
      body: 'session one prompt',
      sessionId: 'f51f7d19-8c8f-4228-9cdd-074ae9b2146e',
      createdAt: '2026-05-11T10:00:00Z',
    },
    {
      ...message,
      messageId: 'msg_s2_u1',
      fromAccountId: 'acct_me',
      toAccountId: 'acct_me',
      direction: 'outgoing',
      body: 'session two prompt',
      sessionId: 'fed8e7f6-fe4a-4598-b83e-3d21a20f978a',
      createdAt: '2026-05-11T10:01:00Z',
    },
    {
      ...message,
      messageId: 'msg_legacy_collapsed',
      fromAccountId: 'acct_me',
      toAccountId: 'acct_me',
      direction: 'outgoing',
      body: 'old collapsed prompt',
      sessionId: null,
      createdAt: '2026-05-11T10:02:00Z',
    },
  ] as CloudMessage[];

  const state = buildCloudDesktopBridgeState({
    account,
    contacts: [],
    messagesByPeer: { acct_me: cloudMessages },
  });

  assert.deepEqual(
    state.conversations.map((conversation) => conversation.canonicalSessionId).sort(),
    ['f51f7d19-8c8f-4228-9cdd-074ae9b2146e', 'fed8e7f6-fe4a-4598-b83e-3d21a20f978a'].sort(),
  );
  const first = state.conversations.find((conversation) => conversation.canonicalSessionId === 'f51f7d19-8c8f-4228-9cdd-074ae9b2146e');
  assert.ok(first);
  assert.equal(first.messages.length, 1);
  assert.equal(first.messages[0].text, 'session one prompt');
});

test('cloud self-agent bridge state restores session titles instead of naming every thread My Kordi', () => {
  const sessionId = 'e2b79cd7-70c0-4cee-ae1b-9bc8cb28da83';
  const cloudMessages = [
    {
      ...message,
      messageId: 'msg_prompt',
      fromAccountId: 'acct_me',
      toAccountId: 'acct_me',
      direction: 'outgoing',
      body: 'what is open claw',
      sessionId,
      createdAt: '2026-05-11T10:00:00Z',
    },
  ] as CloudMessage[];

  const state = buildCloudDesktopBridgeState({
    account,
    contacts: [],
    messagesByPeer: { acct_me: cloudMessages },
    cloudSessionTitlesById: { [sessionId]: 'OpenClaw notes' },
  });

  assert.equal(state.conversations[0]?.title, 'OpenClaw notes');
  assert.equal(state.conversations[0]?.peerDisplayName, 'OpenClaw notes');
});

test('cloud self-agent bridge state falls back to the first prompt as restored title', () => {
  const sessionId = 'e2b79cd7-70c0-4cee-ae1b-9bc8cb28da83';
  const cloudMessages = [
    {
      ...message,
      messageId: 'msg_prompt',
      fromAccountId: 'acct_me',
      toAccountId: 'acct_me',
      direction: 'outgoing',
      body: 'waht is open claw',
      sessionId,
      createdAt: '2026-05-11T10:00:00Z',
    },
  ] as CloudMessage[];

  const state = buildCloudDesktopBridgeState({
    account,
    contacts: [],
    messagesByPeer: { acct_me: cloudMessages },
  });

  assert.equal(state.conversations[0]?.title, 'waht is open claw');
  assert.equal(state.conversations[0]?.peerDisplayName, 'waht is open claw');
});

test('cloud self-agent bridge state suppresses local canonical fork sessions', () => {
  const forkSessionId = 'session:fork:abc123';
  const cloudMessages = [
    {
      ...message,
      messageId: 'msg_fork_prompt',
      fromAccountId: 'acct_me',
      toAccountId: 'acct_me',
      direction: 'outgoing',
      body: 'historical fork prompt',
      sessionId: forkSessionId,
      createdAt: '2026-05-11T10:00:00Z',
    },
  ] as CloudMessage[];

  const visibleState = buildCloudDesktopBridgeState({
    account,
    contacts: [],
    messagesByPeer: { acct_me: cloudMessages },
  });
  assert.equal(visibleState.conversations.some((conversation) => conversation.canonicalSessionId === forkSessionId), true);

  const suppressedState = buildCloudDesktopBridgeState({
    account,
    contacts: [],
    messagesByPeer: { acct_me: cloudMessages },
    hiddenCloudSessionIds: new Set([forkSessionId]),
  });
  assert.equal(suppressedState.conversations.some((conversation) => conversation.canonicalSessionId === forkSessionId), false);
});

test('cloud self-agent plain messages show local processing and match session-scoped replies', () => {
  const sessionId = 'e2b79cd7-70c0-4cee-ae1b-9bc8cb28da83';
  const request = {
    ...message,
    messageId: 'msg_plain_self_request',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_me',
    direction: 'outgoing',
    body: 'are you here',
    sessionId,
    createdAt: new Date().toISOString(),
  } as CloudMessage;
  const pendingState = buildCloudDesktopBridgeState({
    account,
    contacts: [],
    messagesByPeer: { acct_me: [request] },
    activeConversationId: cloudBridgeConversationId('acct_me', 'kordi-desktop', sessionId),
  });

  assert.equal(pendingState.conversations[0]?.awaitingReply, true);
  assert.equal(pendingState.conversations[0]?.outreach?.bridgeRequestId, 'msg_plain_self_request');

  const answeredState = buildCloudDesktopBridgeState({
    account,
    contacts: [],
    messagesByPeer: { acct_me: [request, {
      ...message,
      messageId: 'msg_plain_self_response',
      fromAccountId: 'acct_me',
      toAccountId: 'acct_me',
      direction: 'outgoing',
      body: encodeCloudAgentResponse({ requestId: 'msg_plain_self_request', text: 'Yes, I can see it.' }),
      sessionId,
      createdAt: new Date(Date.now() + 1_000).toISOString(),
    }] },
    activeConversationId: cloudBridgeConversationId('acct_me', 'kordi-desktop', sessionId),
  });

  assert.equal(answeredState.conversations[0]?.awaitingReply, false);
  assert.equal(answeredState.conversations[0]?.outreach, null);
  assert.equal(answeredState.conversations[0]?.messages.at(-1)?.text, 'Yes, I can see it.');
});

test('planCloudSelfAgentSync backfills terminal local self-agent turns without runtime internals', () => {
  const state = {
    sessions: [
      { id: 'local-self-session', kind: 'self-agent', title: 'Hello', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'agent:me', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'cloud-agent:acct_me:runtime', kind: 'self-agent', title: 'Runtime', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'agent:me', createdAtMs: 1, updatedAtMs: 1 },
    ],
    identities: [],
    participants: [],
    profile: { id: 'profile', storageRoot: '/tmp', createdAtMs: 1, updatedAtMs: 1 },
    messages: [
      { id: 'u1', sessionId: 'local-self-session', senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: 'hello', status: 'sent', sequenceNum: 1, createdAtMs: 10, updatedAtMs: 10 },
      { id: 'a1', sessionId: 'local-self-session', senderIdentityId: 'agent:me', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: 'Hi there', status: 'complete', sequenceNum: 2, createdAtMs: 20, updatedAtMs: 20 },
      { id: 'u2', sessionId: 'local-self-session', senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: 'pending', status: 'sending', sequenceNum: 3, createdAtMs: 30, updatedAtMs: 30 },
      { id: 'runtime-u1', sessionId: 'cloud-agent:acct_me:runtime', senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: 'internal', status: 'sent', sequenceNum: 1, createdAtMs: 40, updatedAtMs: 40 },
    ] as CanonicalSessionMessage[],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
    storagePath: '/tmp/canonical.sqlite3',
  } as CanonicalSessionState;

  assert.deepEqual(planCloudSelfAgentSync(state, {}), [
    { localMessageId: 'u1', sessionId: 'local-self-session', role: 'user', text: 'hello', parentLocalMessageId: null, createdAtMs: 10 },
    { localMessageId: 'a1', sessionId: 'local-self-session', role: 'agent', text: 'Hi there', parentLocalMessageId: 'u1', createdAtMs: 20 },
  ]);

  assert.deepEqual(planCloudSelfAgentSync(state, { u1: { cloudMessageId: 'msg_remote', syncedAtMs: 123 } }), [
    { localMessageId: 'a1', sessionId: 'local-self-session', role: 'agent', text: 'Hi there', parentLocalMessageId: 'u1', createdAtMs: 20 },
  ]);
});

test('planCloudSelfAgentSync skips inherited fork snapshot rows but keeps new fork turns', () => {
  const forkSessionId = 'session:fork:abc123';
  const state = {
    sessions: [
      { id: forkSessionId, kind: 'self-agent', title: 'Fork', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'agent:me', metadata: { fork: { forkedFromSessionId: 'session:group:1' } }, createdAtMs: 1, updatedAtMs: 1 },
    ],
    identities: [],
    participants: [],
    profile: { id: 'profile', storageRoot: '/tmp', createdAtMs: 1, updatedAtMs: 1 },
    messages: [
      { id: 'snap-u1', sessionId: forkSessionId, senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: '@MyKordi old prompt', status: 'sent', sequenceNum: 1, createdAtMs: 10, updatedAtMs: 10, sourceTransport: 'canonical-fork-snapshot' },
      { id: 'snap-a1', sessionId: forkSessionId, senderIdentityId: 'agent:me', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: 'old answer', status: 'complete', sequenceNum: 2, createdAtMs: 20, updatedAtMs: 20, sourceTransport: 'canonical-fork-snapshot' },
      { id: 'new-u1', sessionId: forkSessionId, senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: 'new fork prompt', status: 'sent', sequenceNum: 3, createdAtMs: 30, updatedAtMs: 30, sourceTransport: 'desktop-chat' },
      { id: 'new-a1', sessionId: forkSessionId, senderIdentityId: 'agent:me', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: 'new answer', status: 'complete', sequenceNum: 4, createdAtMs: 40, updatedAtMs: 40, sourceTransport: 'desktop-chat' },
    ] as CanonicalSessionMessage[],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
    storagePath: '/tmp/canonical.sqlite3',
  } as CanonicalSessionState;

  assert.deepEqual(planCloudSelfAgentSync(state, {}), [
    { localMessageId: 'new-u1', sessionId: forkSessionId, role: 'user', text: 'new fork prompt', parentLocalMessageId: null, createdAtMs: 30 },
    { localMessageId: 'new-a1', sessionId: forkSessionId, role: 'agent', text: 'new answer', parentLocalMessageId: 'new-u1', createdAtMs: 40 },
  ]);
});

test('cloud group participants hydrate missing avatars from account profiles', () => {
  const participants = cloudGroupParticipantsWithProfiles([
    { accountId: 'acct_79', displayName: '杨澍', avatarUrl: null, role: 'person' },
  ], [
    { accountId: 'acct_79', displayName: '杨澍', avatarUrl: 'https://lh3.googleusercontent.com/a/google-avatar=s96-c' },
  ]);

  assert.deepEqual(participants, [
    { accountId: 'acct_79', displayName: '杨澍', avatarUrl: 'https://lh3.googleusercontent.com/a/google-avatar=s96-c', role: 'person' },
  ]);
});

test('cloud group participant contacts include non-contact group members for mentions and sending', () => {
  const canonicalSessionState = {
    sessions: [{ id: 'session:group:1', kind: 'group', title: 'Group', status: 'active', createdByIdentityId: 'human:acct_me', createdAtMs: 1, updatedAtMs: 1 }],
    identities: [
      { id: 'human:acct_me', kind: 'human', displayName: 'Me Cloud', source: 'local', humanId: 'acct_me', avatarKey: 'seed-me', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'human:acct_member', kind: 'human', displayName: 'Group Member', source: 'bridge', sourceHostId: 'cloud', bridgeNodeId: 'acct_member', humanId: 'acct_member', avatarKey: 'seed-member', profileImageUrl: null, createdAtMs: 1, updatedAtMs: 1 },
    ],
    participants: [
      { sessionId: 'session:group:1', identityId: 'human:acct_me', role: 'self', state: 'active', addedAtMs: 1 },
      { sessionId: 'session:group:1', identityId: 'human:acct_member', role: 'person', state: 'active', addedAtMs: 1 },
    ],
    profile: { id: 'profile', storageRoot: '/tmp', createdAtMs: 1, updatedAtMs: 1 },
    messages: [],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
    storagePath: '/tmp/canonical.sqlite3',
  } as CanonicalSessionState;

  const contacts = cloudGroupParticipantContacts({
    account,
    canonicalSessionState,
    existingPeerIds: [],
  });

  assert.deepEqual(contacts.map((contact) => ({
    id: contact.id,
    name: contact.name,
    bridgeHostId: contact.bridgeHostId,
    bridgePeerNodeId: contact.bridgePeerNodeId,
    bridgeContactStatus: contact.bridgeContactStatus,
    avatarSeed: contact.avatarSeed,
  })), [{
    id: 'cloud:acct_member',
    name: 'Group Member',
    bridgeHostId: 'cloud',
    bridgePeerNodeId: 'acct_member',
    bridgeContactStatus: 'group-member',
    avatarSeed: 'seed-member',
  }]);
});

test('cloud group members do not become direct contacts or direct chat peers', () => {
  const groupMemberContact = {
    ...cloudContactToContact({
      accountId: 'acct_member',
      displayName: 'Group Member',
      avatarUrl: null,
      nodeId: 'acct_member',
      createdAt: '2026-05-11T00:00:00Z',
    }),
    bridgeContactStatus: 'group-member',
  };
  const body = encodeCloudGroupControl({
    kind: 'group-update',
    groupId: 'session:group:one',
    groupSpaceId: 'session:group:one',
    groupTitle: 'Team',
    createdByAccountId: 'acct_peer',
    actor: { accountId: 'acct_peer', displayName: 'Peer Person', avatarUrl: null, role: 'admin' },
    participants: [
      { accountId: 'acct_me', displayName: 'Me Cloud', avatarUrl: null, role: 'person' },
      { accountId: 'acct_member', displayName: 'Group Member', avatarUrl: null, role: 'person' },
    ],
    message: null,
  });
  const state = buildCloudDesktopBridgeState({
    account,
    contacts: [peer, groupMemberContact],
    messagesByPeer: {
      acct_peer: [message],
      acct_member: [{
        messageId: 'msg_group_control',
        fromAccountId: 'acct_member',
        toAccountId: 'acct_me',
        body,
        createdAt: '2026-05-11T10:00:00Z',
        deliveredAt: null,
        readAt: null,
        direction: 'incoming',
      }],
    },
  });

  assert.equal(state.hosts[0]?.visiblePeers.some((visiblePeer) => visiblePeer.humanId === 'acct_member'), false);
  assert.equal(state.conversations.some((conversation) => conversation.peerNodeId === 'acct_member'), false);
  assert.equal(state.conversations.some((conversation) => conversation.peerNodeId === 'acct_peer'), true);
});

test('cloud contact identity requests preserve account ids, display names, and shared avatar seeds', () => {
  const requests = cloudContactsToCanonicalIdentityRequests({
    account: {
      ...account,
      avatarUrl: 'kordi-pixel-avatar://cloud-signup:me-seed',
    },
    contacts: [cloudContactToContact({
      accountId: 'acct_peer',
      displayName: 'Peer Person',
      avatarUrl: 'kordi-pixel-avatar://cloud-signup:peer-seed',
      nodeId: 'node_peer',
      createdAt: '2026-05-11T00:00:00Z',
    })],
    localHumanIdentityId: 'human:local',
  });

  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map((request) => ({
    id: request.id,
    displayName: request.displayName,
    source: request.source,
    sourceHostId: request.sourceHostId,
    bridgeNodeId: request.bridgeNodeId,
    humanId: request.humanId,
    avatarKey: request.avatarKey,
    profileImageUrl: request.profileImageUrl,
  })), [
    {
      id: 'human:local',
      displayName: 'Me Cloud',
      source: 'local',
      sourceHostId: null,
      bridgeNodeId: null,
      humanId: 'acct_me',
      avatarKey: 'cloud-signup:me-seed',
      profileImageUrl: null,
    },
    {
      id: 'human:acct_peer',
      displayName: 'Peer Person',
      source: 'bridge',
      sourceHostId: 'cloud',
      bridgeNodeId: 'acct_peer',
      humanId: 'acct_peer',
      avatarKey: 'cloud-signup:peer-seed',
      profileImageUrl: null,
    },
  ]);
});

test('cloud bootstrap peers include the signed-in account for private self-agent restore', () => {
  assert.deepEqual(cloudBootstrapPeerIds(account, ['acct_peer'], []), ['acct_me', 'acct_peer']);
});

test('cloud initial message readiness waits for the post-contact peer set', () => {
  assert.equal(cloudInitialMessagesSettledForPeerKey({
    accountReady: true,
    contactsSettled: true,
    currentPeerKey: 'acct_me|acct_peer',
    settledPeerKey: 'acct_me',
  }), false);

  assert.equal(cloudInitialMessagesSettledForPeerKey({
    accountReady: true,
    contactsSettled: true,
    currentPeerKey: 'acct_me|acct_peer',
    settledPeerKey: 'acct_me|acct_peer',
  }), true);
});

test('cloud initial message sync follows group peer discovery until stable', async () => {
  const makeGroupMessage = (peer: string, discoveredPeer: string): CloudMessage => ({
    messageId: `msg_${peer}_${discoveredPeer}`,
    fromAccountId: peer,
    toAccountId: account.accountId,
    body: encodeCloudGroupControl({
      kind: 'group-message',
      groupId: `group_${peer}_${discoveredPeer}`,
      sessionId: `session_${peer}_${discoveredPeer}`,
      createdByAccountId: peer,
      actor: { accountId: peer, displayName: peer, avatarUrl: null },
      participants: [
        { accountId: account.accountId, displayName: 'Me Cloud', avatarUrl: null },
        { accountId: peer, displayName: peer, avatarUrl: null },
        { accountId: discoveredPeer, displayName: discoveredPeer, avatarUrl: null },
      ],
      message: {
        id: `group_msg_${peer}_${discoveredPeer}`,
        senderAccountId: peer,
        text: `hello ${discoveredPeer}`,
        createdAt: '2026-05-13T10:00:00Z',
      },
    }),
    createdAt: '2026-05-13T10:00:00Z',
    deliveredAt: '2026-05-13T10:00:00Z',
    readAt: null,
    direction: 'incoming',
  });

  const messagesByPeer: Record<string, CloudMessage[]> = {
    acct_peer_1: [makeGroupMessage('acct_peer_1', 'acct_peer_2')],
    acct_peer_2: [makeGroupMessage('acct_peer_2', 'acct_peer_3')],
    acct_peer_3: [makeGroupMessage('acct_peer_3', 'acct_peer_4')],
    acct_peer_4: [makeGroupMessage('acct_peer_4', 'acct_peer_5')],
    acct_peer_5: [],
  };

  const result = await loadCloudMessagesByPeerUntilStable({
    accountId: account.accountId,
    initialPeerIds: ['acct_peer_1'],
    existingMessagesByPeer: {},
    listMessages: async (peerId) => messagesByPeer[peerId] ?? [],
    resolveMessageAttachments: async (messages) => messages,
  });

  assert.equal(result.complete, true);
  assert.deepEqual(Object.keys(result.messagesByPeer).sort(), [
    'acct_peer_1',
    'acct_peer_2',
    'acct_peer_3',
    'acct_peer_4',
    'acct_peer_5',
  ]);
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

  const state = buildCloudDesktopBridgeState({
    account,
    contacts: [],
    messagesByPeer: { acct_me: [selfRequest, selfResponse] },
    activeConversationId: null,
  });

  assert.equal(state.conversations.length, 1);
  assert.equal(state.conversations[0].id, 'bridge:cloud:acct_me');
  assert.equal(state.conversations[0].title, 'My Kordi');
  assert.equal(state.conversations[0].peerRuntime, 'kordi-desktop');
  assert.equal(state.conversations[0].identity.remoteAgentId, 'cloud-local-agent');
  assert.deepEqual(state.conversations[0].messages.map((item) => item.text), [
    '@Kordi remember this private note',
    'I will remember it.',
  ]);
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

  const state = buildCloudDesktopBridgeState({
    account,
    contacts: [],
    messagesByPeer: { acct_me: [selfRequest, selfResponse] },
    activeConversationId: null,
    suppressUnscopedSelfAgentConversation: true,
  });

  assert.equal(state.conversations.length, 0);
});

test('cloud contacts and messages become normal desktop bridge state', () => {
  const state = buildCloudDesktopBridgeState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [message] },
    activeConversationId: null,
  });

  assert.equal(state.hosts[0].id, 'cloud');
  assert.equal(state.hosts[0].visiblePeers.some((candidate) => candidate.runtime === 'person'), true);
  assert.equal(state.hosts[0].visiblePeers.some((candidate) => candidate.runtime === 'kordi-desktop' && candidate.agentId === 'cloud-agent:acct_peer'), true);
  assert.equal(state.conversations.length, 1);
  assert.equal(state.conversations[0].id, 'bridge:cloud:acct_peer:person');
  assert.equal(state.conversations[0].messages[0].direction, 'inbound');
  assert.equal(state.conversations[0].messages[0].text, 'hello from cloud');
});

test('active empty cloud conversations are materialized for the existing chat UI', () => {
  const state = buildCloudDesktopBridgeState({
    account,
    contacts: [peer],
    messagesByPeer: {},
    activeConversationId: 'bridge:cloud:acct_peer:person',
  });

  assert.equal(state.conversations.length, 1);
  assert.equal(state.conversations[0].messages.length, 0);
  assert.equal(state.conversations[0].title, 'Peer Person');
});

test('active cloud conversations clear unread while inactive conversations keep unread', () => {
  const activeState = buildCloudDesktopBridgeState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [message] },
    activeConversationId: 'bridge:cloud:acct_peer:person',
  });
  const inactiveState = buildCloudDesktopBridgeState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [message] },
    activeConversationId: null,
  });

  assert.equal(activeState.conversations[0].unreadCount, 0);
  assert.equal(inactiveState.conversations[0].unreadCount, 1);
});

test('cloud read markers keep previously read inbound messages from becoming unread again', () => {
  const state = buildCloudDesktopBridgeState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [message] },
    readInboundMessageIdsByPeer: { acct_peer: new Set(['msg_1']) },
    activeConversationId: null,
  });

  assert.equal(state.conversations[0].unreadCount, 0);
});

test('cloud self-agent messages never count as unread badges', () => {
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
  const state = buildCloudDesktopBridgeState({
    account,
    contacts: [],
    messagesByPeer: { acct_me: [selfMessage] },
    activeConversationId: null,
  });

  assert.equal(state.conversations.length, 1);
  assert.equal(state.conversations[0].canonicalSessionId, 'f51f7d19-8c8f-4228-9cdd-074ae9b2146e');
  assert.equal(state.conversations[0].unreadCount, 0);
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
  const state = buildCloudDesktopBridgeState({
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
  const state = buildCloudDesktopBridgeState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [outgoing] },
    activeConversationId: 'bridge:cloud:acct_peer:person',
  });

  assert.equal(state.conversations[0].messages[0].deliveryState, 'delivered');
});

test('cloud cloud-agent mention requests and responses use bridge agent directions', () => {
  const request = cloudMessageToBridgeMessage(account, {
    ...message,
    messageId: 'msg_request',
    body: '@MeCloudKordi who are you?',
  });
  const response = cloudMessageToBridgeMessage(account, {
    ...message,
    messageId: 'msg_response',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    body: encodeCloudAgentResponse({ requestId: 'msg_request', text: 'I am Kordi.' }),
    direction: 'outgoing',
  });

  assert.equal(request.direction, 'inbound');
  assert.equal(request.requestId, 'msg_request');
  assert.equal(response.direction, 'outbound-response');
  assert.equal(response.sender, null);
  assert.equal(response.requestId, 'msg_request');
  assert.equal(response.text, 'I am Kordi.');
});

test('cloud self-agent responses keep local runtime tool details local to the owner', () => {
  const request: CloudMessage = {
    ...message,
    messageId: 'msg_self_agent_request_with_tools',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    body: '@MyMeCloud inspect the repo',
    direction: 'outgoing',
  };
  const response: CloudMessage = {
    ...message,
    messageId: 'msg_self_agent_response_with_tools',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    body: encodeCloudAgentResponse({ requestId: request.messageId, text: 'I inspected it.' }),
    direction: 'outgoing',
  };
  const state = buildCloudDesktopBridgeState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [request, response] },
    activeConversationId: 'bridge:cloud:acct_peer:person',
    localAgentTurnsByRequestId: {
      [request.messageId]: {
        id: 'turn_1',
        sessionId: 'cloud-agent:acct_me:acct_peer',
        prompt: 'inspect the repo',
        status: 'complete',
        message: 'Complete',
        assistantText: 'I inspected it.',
        thinkingText: 'Looking through files.',
        tools: [{ id: 'tool_1', name: 'read', status: 'completed', arguments: '{}', detail: 'Read package.json', resultText: '', liveOutput: '', isError: false }],
        completed: true,
        succeeded: true,
        error: null,
      },
    },
  });

  const bridgeResponse = state.conversations[0].messages.find((candidate) => candidate.id === response.messageId);
  assert.equal(bridgeResponse?.sender, null);
  assert.equal(bridgeResponse?.localTurn?.tools[0]?.name, 'read');

  const view = mapBridgeConversationToViewModel(state.conversations[0], state.hosts[0], 'Kordi');
  const agentMessage = view.messages.find((candidate) => candidate.role === 'owned-agent');
  assert.equal(agentMessage?.sender, 'My Kordi');
  assert.equal(agentMessage?.turn?.tools[0]?.name, 'read');
});

test('cloud first-person self-agent requests hide accidental duplicate peer responses', () => {
  const request: CloudMessage = {
    ...message,
    messageId: 'msg_first_person_request',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    body: '@MyKordi what is agentic?',
    direction: 'outgoing',
  };
  const validResponse: CloudMessage = {
    ...message,
    messageId: 'msg_valid_self_response',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    body: encodeCloudAgentResponse({ requestId: request.messageId, text: 'Agentic means acting autonomously.' }),
    direction: 'outgoing',
  };
  const invalidDuplicateResponse: CloudMessage = {
    ...message,
    messageId: 'msg_invalid_peer_response',
    fromAccountId: 'acct_peer',
    toAccountId: 'acct_me',
    body: encodeCloudAgentResponse({ requestId: request.messageId, text: 'Duplicate response.' }),
    direction: 'incoming',
  };
  const state = buildCloudDesktopBridgeState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [request, validResponse, invalidDuplicateResponse] },
    activeConversationId: 'bridge:cloud:acct_peer:person',
  });

  const responses = state.conversations[0].messages.filter((candidate) => candidate.requestId === request.messageId && candidate.id !== request.messageId);
  assert.equal(responses.length, 1);
  assert.equal(responses[0].id, validResponse.messageId);
});

test('cloud remote-agent responses render with the remote owner agent identity', () => {
  const request: CloudMessage = {
    ...message,
    messageId: 'msg_remote_agent_request_label',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    body: '@PeerPersonKordi hi',
    direction: 'outgoing',
  };
  const response: CloudMessage = {
    ...message,
    messageId: 'msg_remote_agent_response_label',
    fromAccountId: 'acct_peer',
    toAccountId: 'acct_me',
    body: encodeCloudAgentResponse({ requestId: request.messageId, text: 'Hello.' }),
    direction: 'incoming',
  };
  const state = buildCloudDesktopBridgeState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [request, response] },
    activeConversationId: 'bridge:cloud:acct_peer:person',
  });
  const view = mapBridgeConversationToViewModel(state.conversations[0], state.hosts[0], 'Kordi');
  const agentMessage = view.messages.find((candidate) => candidate.role === 'external-agent');
  assert.equal(agentMessage?.sender, "Peer Person's Kordi");
});

test('active cloud agent bridge placeholders are not materialized as duplicate sessions', () => {
  const state = buildCloudDesktopBridgeState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [message] },
    activeConversationId: 'bridge:cloud:acct_peer',
  });

  assert.equal(state.conversations.some((conversation) => conversation.id === 'bridge:cloud:acct_peer:person'), true);
  assert.equal(state.conversations.some((conversation) => conversation.id === 'bridge:cloud:acct_peer'), false);
});

test('cloud parallel agent mentions keep request-specific processing and replies', () => {
  const firstRequest: CloudMessage = {
    ...message,
    messageId: 'msg_first_agent_request',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    body: '@PeerPersonKordi check openclaw',
    direction: 'outgoing',
    createdAt: '2026-05-11T10:00:00Z',
  };
  const secondRequest: CloudMessage = {
    ...message,
    messageId: 'msg_second_agent_request',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    body: '@PeerPersonKordi are you ok?',
    direction: 'outgoing',
    createdAt: new Date().toISOString(),
  };
  const firstResponse: CloudMessage = {
    ...message,
    messageId: 'msg_first_agent_response',
    fromAccountId: 'acct_peer',
    toAccountId: 'acct_me',
    body: encodeCloudAgentResponse({ requestId: 'msg_first_agent_request', text: 'OpenClaw is an agent project.' }),
    direction: 'incoming',
    createdAt: '2026-05-11T10:02:00Z',
  };
  const state = buildCloudDesktopBridgeState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [firstRequest, secondRequest, firstResponse] },
    activeConversationId: 'bridge:cloud:acct_peer:person',
  });
  const view = mapBridgeConversationToViewModel(state.conversations[0], state.hosts[0], 'Kordi');
  const firstRequestViewId = 'bridge-message:bridge:cloud:acct_peer:person:msg_first_agent_request';
  const secondRequestViewId = 'bridge-message:bridge:cloud:acct_peer:person:msg_second_agent_request';
  const firstReply = view.messages.find((candidate) => candidate.id?.includes('msg_first_agent_response'));
  const pendingReplies = view.messages.filter((candidate) => candidate.turn?.status === 'processing');

  assert.equal(firstReply?.replyToMessageId, firstRequestViewId);
  assert.equal(pendingReplies.length, 1);
  assert.equal(pendingReplies[0]?.replyToMessageId, secondRequestViewId);
  assert.deepEqual(pendingReplies[0]?.turn?.pendingBridgeAgentRequest, {
    conversationId: 'bridge:cloud:acct_peer:person',
    requestId: 'msg_second_agent_request',
  });
});

test('cloud human mentions do not start cloud-agent processing UI', () => {
  const humanMention: CloudMessage = {
    ...message,
    messageId: 'msg_human_mention',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    body: '@PeerPerson hi',
    direction: 'outgoing',
  };
  const state = buildCloudDesktopBridgeState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [humanMention] },
    activeConversationId: 'bridge:cloud:acct_peer:person',
  });

  assert.equal(state.conversations[0].awaitingReply, false);
  assert.equal(state.conversations[0].outreach, null);
  assert.equal(state.conversations[0].messages[0].direction, 'outbound');
});

test('cloud incoming local-agent mentions expose synced processing UI', () => {
  const request: CloudMessage = {
    ...message,
    messageId: 'msg_local_agent_request',
    fromAccountId: 'acct_peer',
    toAccountId: 'acct_me',
    body: '@MeCloudKordi who are you?',
    direction: 'incoming',
  };
  const state = buildCloudDesktopBridgeState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [request] },
    activeConversationId: 'bridge:cloud:acct_peer:person',
  });

  assert.equal(state.conversations[0].awaitingReply, true);
  assert.equal(state.conversations[0].outreach?.targetKind, 'bridge-agent');
  assert.equal(state.conversations[0].outreach?.bridgeRequestId, 'msg_local_agent_request');
  assert.equal(state.conversations[0].outreach?.targetAgentId, 'cloud-local-agent');
});

test('cloud outgoing self-agent mentions expose localhost-style local processing UI', () => {
  const request: CloudMessage = {
    ...message,
    messageId: 'msg_self_agent_request',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    body: '@MyMeCloudKordi who are you?',
    direction: 'outgoing',
  };
  const pendingState = buildCloudDesktopBridgeState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [request] },
    activeConversationId: 'bridge:cloud:acct_peer:person',
  });

  assert.equal(pendingState.conversations[0].awaitingReply, true);
  assert.equal(pendingState.conversations[0].outreach?.targetKind, 'bridge-agent');
  assert.equal(pendingState.conversations[0].outreach?.bridgeRequestId, 'msg_self_agent_request');
  assert.equal(pendingState.conversations[0].outreach?.targetAgentId, 'cloud-local-agent');
  assert.equal(pendingState.conversations[0].outreach?.targetNodeId, 'acct_me');

  const answeredState = buildCloudDesktopBridgeState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [request, {
      ...message,
      messageId: 'msg_self_agent_response',
      fromAccountId: 'acct_me',
      toAccountId: 'acct_peer',
      body: encodeCloudAgentResponse({ requestId: 'msg_self_agent_request', text: 'I am your Kordi.' }),
      direction: 'outgoing',
    }] },
    activeConversationId: 'bridge:cloud:acct_peer:person',
  });

  assert.equal(answeredState.conversations[0].awaitingReply, false);
  assert.equal(answeredState.conversations[0].outreach, null);
  assert.equal(answeredState.conversations[0].messages[1].direction, 'outbound-response');
});

test('cloud outgoing remote-agent mentions become offline replies after timeout', () => {
  const request: CloudMessage = {
    ...message,
    messageId: 'msg_agent_request_offline',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    body: '@PeerPersonKordi hello',
    direction: 'outgoing',
    createdAt: '2026-05-11T08:00:00Z',
  };
  const state = buildCloudDesktopBridgeState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [request] },
    activeConversationId: 'bridge:cloud:acct_peer:person',
  });

  assert.equal(state.conversations[0].awaitingReply, false);
  assert.equal(state.conversations[0].outreach, null);
  const offlineMessage = state.conversations[0].messages.find((candidate) => candidate.id === 'cloud-agent-offline:msg_agent_request_offline');
  assert.equal(offlineMessage?.deliveryState, 'failed');
  assert.equal(offlineMessage?.text, "Peer Person and Peer Person's Kordi are offline.");

  const view = mapBridgeConversationToViewModel(state.conversations[0], state.hosts[0], 'Kordi');
  const offlineTurn = view.messages.find((candidate) => candidate.role === 'external-agent')?.turn;
  assert.equal(offlineTurn?.status, 'failed');
  assert.equal(offlineTurn?.assistantText, '');
  assert.equal(offlineTurn?.error, "Peer Person and Peer Person's Kordi are offline.");
  assert.equal(offlineTurn?.pendingBridgeAgentRequest, null);
});

test('cloud outgoing remote-agent mentions expose localhost-style pending outreach UI', () => {
  const request: CloudMessage = {
    ...message,
    messageId: 'msg_agent_request',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    body: '@PeerPersonKordi who are you?',
    direction: 'outgoing',
    createdAt: new Date().toISOString(),
  };
  const pendingState = buildCloudDesktopBridgeState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [request] },
    activeConversationId: 'bridge:cloud:acct_peer:person',
  });

  assert.equal(pendingState.conversations[0].awaitingReply, true);
  assert.equal(pendingState.conversations[0].outreach?.targetKind, 'bridge-agent');
  assert.equal(pendingState.conversations[0].outreach?.bridgeRequestId, 'msg_agent_request');
  assert.equal(pendingState.conversations[0].outreach?.parentSessionId, null);

  const answeredState = buildCloudDesktopBridgeState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [request, {
      ...message,
      messageId: 'msg_agent_response',
      fromAccountId: 'acct_peer',
      toAccountId: 'acct_me',
      body: encodeCloudAgentResponse({ requestId: 'msg_agent_request', text: 'I am Kordi.' }),
      direction: 'incoming',
    }] },
    activeConversationId: 'bridge:cloud:acct_peer:person',
  });

  assert.equal(answeredState.conversations[0].awaitingReply, false);
  assert.equal(answeredState.conversations[0].outreach, null);
});

test('cloud agent optimistic cancel controls have the same shape as server cancel controls', () => {
  const cancel = optimisticCloudAgentCancelMessage({
    account,
    peerAccountId: 'acct_peer',
    requestId: 'msg_cancel_request',
    now: 1_234,
  });

  assert.equal(cancel.fromAccountId, 'acct_me');
  assert.equal(cancel.toAccountId, 'acct_peer');
  assert.equal(cancel.direction, 'outgoing');
  assert.equal(cancel.body, encodeCloudAgentCancel({ requestId: 'msg_cancel_request' }));
  assert.equal(cancel.createdAt, new Date(1_234).toISOString());
});

test('cloud group cancel finds requesting placeholders before processing reaches the agent', () => {
  const requesting = {
    id: 'msg:cloud-agent-offline:msg_request:acct_peer',
    sessionId: 'session:group',
    senderIdentityId: 'agent:cloud:acct_peer',
    senderRole: 'external-agent',
    messageKind: 'agent-turn',
    contentText: 'Requesting…',
    content: { requestId: 'msg_request', deliveryState: 'processing' },
    parentMessageId: 'msg_request',
    status: 'processing',
    sequenceNum: 1,
    createdAtMs: 1,
    updatedAtMs: 1,
    contentHash: null,
    sourceTransport: 'cloud-group-agent-offline',
    sourceEventId: 'cloud-group-agent-offline:msg_request:acct_peer',
  } as CanonicalSessionMessage;

  assert.equal(
    cloudGroupAgentProcessingMessageForRequest([requesting], 'session:group', 'msg_request')?.id,
    requesting.id,
  );
});

test('cloud group terminal responses reuse an existing peer processing slot', () => {
  const processing = {
    id: 'msg:cloud-agent-processing:msg_request:acct_peer',
    sessionId: 'session:group',
    senderIdentityId: 'agent:cloud:acct_peer',
    senderRole: 'external-agent',
    messageKind: 'agent-turn',
    contentText: 'processing...',
    content: { sender: "Peer's Kordi", requestId: 'msg_request', deliveryState: 'processing' },
    parentMessageId: 'msg_request',
    status: 'processing',
    sequenceNum: 1,
    createdAtMs: 1,
    updatedAtMs: 1,
    contentHash: null,
    sourceTransport: 'cloud-group-agent',
    sourceEventId: 'cloud-group-agent:msg:cloud-agent-processing:msg_request:acct_peer',
  } as CanonicalSessionMessage;
  const unrelatedOtherAgentProcessing = {
    ...processing,
    id: 'msg:cloud-agent-processing:msg_request:acct_other',
    senderIdentityId: 'agent:cloud:acct_other',
  } as CanonicalSessionMessage;

  assert.equal(
    cloudGroupAgentProcessingSlotForResponse(
      [unrelatedOtherAgentProcessing, processing],
      'session:group',
      'msg_request',
      'acct_peer',
    )?.id,
    processing.id,
  );
});

test('cloud group cancel notices record sender or agent owner role', () => {
  const processing = {
    id: 'msg:cloud-agent-offline:msg_request:acct_peer',
    sessionId: 'session:group',
    senderIdentityId: 'agent:cloud:acct_peer',
    senderRole: 'external-agent',
    messageKind: 'agent-turn',
    contentText: 'processing...',
    content: { sender: "Peer's Kordi", requestId: 'msg_request', deliveryState: 'processing' },
    parentMessageId: 'msg_request',
    status: 'processing',
    sequenceNum: 1,
    createdAtMs: 1,
    updatedAtMs: 1,
    contentHash: null,
    sourceTransport: 'cloud-group-agent-offline',
    sourceEventId: 'cloud-group-agent-offline:msg_request:acct_peer',
  } as CanonicalSessionMessage;
  const canonicalState = {
    storagePath: '/tmp/canonical.sqlite3',
    profile: { id: 'profile', displayName: 'Me', humanIdentityId: 'human:me', storageRoot: '/tmp', createdAtMs: 1, updatedAtMs: 1 },
    identities: [
      { id: 'human:me', kind: 'human', displayName: 'Me', source: 'local', humanId: 'acct_me', avatarKey: 'me', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'human:peer', kind: 'human', displayName: 'Peer', source: 'bridge', humanId: 'acct_peer', avatarKey: 'peer', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [],
    participants: [],
    messages: [
      { id: 'msg_request', sessionId: 'session:group', senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: '@PeerKordi hi', content: {}, status: 'sent', sequenceNum: 0, createdAtMs: 1, updatedAtMs: 1, contentHash: null, sourceTransport: 'cloud-group', sourceEventId: 'request' },
      processing,
    ],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  } as CanonicalSessionState;

  assert.equal(cloudGroupAgentCancelRoleForRequest({ state: canonicalState, requestId: 'msg_request', processingMessage: processing, cancelledByAccountId: 'acct_me' }), 'sender');
  assert.equal(cloudGroupAgentCancelRoleForRequest({ state: canonicalState, requestId: 'msg_request', processingMessage: processing, cancelledByAccountId: 'acct_peer' }), 'agent owner');

  const notice = cloudGroupAgentCancelledNoticeRequest({
    processingMessage: processing,
    requestId: 'msg_request',
    conversationId: 'cloud-group-agent:session:group',
    cancelledByAccountId: 'acct_me',
    cancelledByRole: 'sender',
    now: 1_234,
  });

  assert.equal(notice.contentText, 'Request canceled by sender.');
  assert.deepEqual(notice.content, {
    sender: "Peer's Kordi",
    timestampMs: 1_234,
    deliveryState: 'cancelled',
    bridgeConversationId: 'cloud-group-agent:session:group',
    requestId: 'msg_request',
    replyToMessageId: 'msg_request',
    cancelledByAccountId: 'acct_me',
    cancelledByRole: 'sender',
  });
});

test('cloud agent cancel controls are hidden and show who cancelled the request', () => {
  const request: CloudMessage = {
    ...message,
    messageId: 'msg_cancel_request',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    body: '@PeerPersonKordi who are you?',
    direction: 'outgoing',
  };
  const cancel: CloudMessage = {
    ...message,
    messageId: 'msg_cancel_control',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    body: encodeCloudAgentCancel({ requestId: 'msg_cancel_request' }),
    direction: 'outgoing',
  };
  const state = buildCloudDesktopBridgeState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [request, cancel] },
    activeConversationId: 'bridge:cloud:acct_peer:person',
  });

  const view = mapBridgeConversationToViewModel(state.conversations[0], state.hosts[0], 'Kordi');

  assert.equal(state.conversations[0].awaitingReply, false);
  assert.equal(state.conversations[0].messages.length, 2);
  assert.equal(state.conversations[0].messages[0].deliveryState, 'cancelled');
  assert.equal(state.conversations[0].messages[1].deliveryState, 'cancelled');
  assert.equal(view.messages[1]?.turn?.status, 'cancelled');
  assert.equal(view.messages[1]?.turn?.assistantText, 'Request canceled by sender.');
});

test('cloud outgoing messages render as read when the peer read timestamp is present', () => {
  const readOutgoing: CloudMessage = {
    ...message,
    messageId: 'msg_read',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    body: 'hi',
    deliveredAt: '2026-05-11T10:00:01Z',
    readAt: '2026-05-11T10:00:02Z',
    direction: 'outgoing',
  };
  const state = buildCloudDesktopBridgeState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [readOutgoing] },
    activeConversationId: 'bridge:cloud:acct_peer:person',
  });

  assert.equal(state.conversations[0].messages[0].deliveryState, 'read');
});
