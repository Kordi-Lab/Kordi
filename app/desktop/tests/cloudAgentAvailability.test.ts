import { cloudAccountAvatarFixture } from './helpers/cloudAccountAvatarFixture';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CloudAccount, CloudMessage } from '../src/features/cloud/authClient';
import { encodeCloudDirectMessageEnvelope } from '../src/features/cloud/cloudDirectMessages';
import { cloudDirectPersonSessionId } from '../src/features/cloud/cloudCollaborationState';
import { cloudContactToContact } from '../src/features/cloud/useCloudContacts';
import { sharedCloudAgentMentionCandidatesForConversation } from '../src/features/chat/messageActions/mentions';
import {
  cloudAgentMentionCandidates,
  shouldRunLocalCloudAgentForCloudMessage,
} from '../src/features/cloud/cloudAgentMentionPolicy';
import {
  cloudFallbackRunClaimsForMessages,
} from '../src/features/cloud/cloudAgentFallbackClaims';
import type { CanonicalSessionState } from '../src/kordi-app/types';
import { createCanonicalSessionReadModel } from '../src/features/canonical/sessionReadModel';
import { appendCloudGroupRequestingPlaceholder } from '../src/features/cloud/cloudAgentRequestState';
import { encodeCloudGroupControl } from '../src/features/cloud/cloudGroupMessages';

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

test('shared cloud agent mention candidates require owner participant', () => {
  const sharedAgent = {
    agentId: 'cloud_agent_project',
    ownerAccountId: 'acct_owner',
    ownerDisplayName: 'Alex',
    accessScope: 'participant_conversations' as const,
    name: 'Project Driver',
    role: 'Planning agent',
    description: null,
    updatedAt: '2026-06-19T00:00:00Z',
  };

  const withOwner = sharedCloudAgentMentionCandidatesForConversation([sharedAgent], {
    canonicalParticipants: [
      {
        id: 'human:acct_owner',
        kind: 'human',
        role: 'person',
        name: 'Alex',
        humanId: 'acct_owner',
      },
      {
        id: 'human:acct_requester',
        kind: 'human',
        role: 'self',
        name: 'Alice',
        humanId: 'acct_requester',
      },
    ],
    directness: 'group',
  });

  assert.equal(withOwner[0]?.handle, 'ProjectDriver');
  assert.equal(withOwner[0]?.targetAgentId, 'cloud_agent_project');
  assert.equal(withOwner[0]?.targetOwnerAccountId, 'acct_owner');
  assert.equal(withOwner[0]?.detailLabel, 'Owner · Alex');

  const withoutOwner = sharedCloudAgentMentionCandidatesForConversation(
    [sharedAgent],
    {
      canonicalParticipants: [
        {
          id: 'human:acct_requester',
          kind: 'human',
          role: 'self',
          name: 'Alice',
          humanId: 'acct_requester',
        },
      ],
      directness: 'group',
    },
  );
  assert.deepEqual(withoutOwner, []);
});

test('cloud group agent mention candidates include owner self-mentions for hosted Cloud Agents', () => {
  const state = {
    profile: { humanIdentityId: 'human:me', displayName: '111' },
    sessions: [],
    identities: [
      {
        id: 'human:me',
        kind: 'human',
        displayName: '111',
        source: 'bridge',
        sourceIdentityId: 'acct_me',
        humanId: 'acct_me',
        ownerIdentityId: null,
        sourceHostId: 'cloud',
        agentId: null,
        avatarKey: 'me',
        profileImageUrl: null,
        metadata: null,
        createdAtMs: 1,
        updatedAtMs: 1,
      },
    ],
    participants: [],
    messages: [{
      id: 'msg_self_hosted_agent_request',
      sessionId: 'session:group:abc',
      senderIdentityId: 'human:me',
      senderRole: 'user',
      messageKind: 'text',
      contentText: '@KordiProjectDriver hi',
      content: {
        mentions: [{
          targetKind: 'agent',
          sourceHostId: 'cloud',
          humanId: 'acct_me',
          agentId: 'cloud_agent_project',
          label: 'Kordi Project Driver',
          ownerName: '111',
        }],
      },
      parentMessageId: null,
      delegatedExchangeId: null,
      status: 'sent',
      sequenceNum: 1,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      contentHash: null,
      sourceTransport: 'cloud-group-ui',
      sourceEventId: 'cloud-group:msg_self_hosted_agent_request',
    }],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
    storagePath: null,
  } satisfies CanonicalSessionState;

  const candidates = cloudAgentMentionCandidates(state, 'acct_me');

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.targetAccountId, 'acct_me');
  assert.equal(candidates[0]?.targetCloudAgentId, 'cloud_agent_project');
  assert.equal(candidates[0]?.targetAgentDisplayName, 'Kordi Project Driver');
});

test('direct Cloud hosted shared-agent mentions stay eligible for direct fallback runs', () => {
  const body = encodeCloudDirectMessageEnvelope({
    schemaVersion: 1,
    kind: 'message',
    text: '@KordiProjectDriver hi',
    targetCloudAgentId: 'cloud_agent_project',
    targetCloudAgentName: 'Kordi Project Driver',
    targetCloudAgentOwnerAccountId: 'acct_peer',
    targetCloudAgentOwnerName: 'Peer Person',
  });
  const message: CloudMessage = {
    messageId: 'msg_direct_shared_agent',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    body,
    createdAt: new Date().toISOString(),
    direction: 'outgoing',
    readAt: null,
    sessionId: cloudDirectPersonSessionId('acct_me', 'acct_peer'),
    attachments: [],
  };

  assert.equal(shouldRunLocalCloudAgentForCloudMessage({
    account: { ...account, accountId: 'acct_peer' },
    peerId: 'acct_me',
    message,
    peerMessages: [message],
  }), true);

  const claims = cloudFallbackRunClaimsForMessages({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [message] },
  });
  assert.equal(claims.length, 1);
  assert.equal(
    claims[0]?.sessionId,
    cloudDirectPersonSessionId('acct_me', 'acct_peer'),
  );
  assert.equal(claims[0]?.targetCloudAgentId, 'cloud_agent_project');
});

test('direct Cloud contact agent mentions are not treated as Cloud group placeholders', () => {
  const state = {
    profile: { humanIdentityId: 'human:me', displayName: 'Me' },
    sessions: [],
    identities: [
      {
        id: 'human:peer',
        kind: 'human',
        displayName: 'Peer Person',
        source: 'bridge',
        sourceIdentityId: 'acct_peer',
        humanId: 'acct_peer',
        ownerIdentityId: null,
        sourceHostId: 'cloud',
        agentId: null,
        avatarKey: 'peer',
        profileImageUrl: null,
        metadata: null,
        createdAtMs: 1,
        updatedAtMs: 1,
      },
      {
        id: 'agent:cloud:acct_peer',
        kind: 'agent',
        displayName: "Peer Person's Kordi",
        source: 'bridge',
        sourceIdentityId: 'cloud-agent:acct_peer',
        humanId: 'acct_peer',
        ownerIdentityId: 'human:peer',
        sourceHostId: 'cloud',
        agentId: 'cloud-agent:acct_peer',
        avatarKey: 'peer-agent',
        profileImageUrl: null,
        metadata: null,
        createdAtMs: 1,
        updatedAtMs: 1,
      },
    ],
    participants: [],
    messages: [{
      id: 'msg_direct_request',
      sessionId: 'session:direct-person:acct_me:acct_peer',
      senderIdentityId: 'human:me',
      senderRole: 'user',
      messageKind: 'text',
      contentText: '@PeerKordi hi',
      content: {
        mentions: [{
          targetKind: 'agent',
          sourceHostId: 'cloud',
          humanId: 'acct_peer',
          label: "Peer's Kordi",
        }],
      },
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
      {
        id: 'human:peer',
        kind: 'human',
        displayName: 'Peer Person',
        source: 'bridge',
        sourceIdentityId: 'acct_peer',
        humanId: 'acct_peer',
        ownerIdentityId: null,
        sourceHostId: 'cloud',
        agentId: null,
        avatarKey: 'peer',
        profileImageUrl: null,
        metadata: null,
        createdAtMs: 1,
        updatedAtMs: 1,
      },
      {
        id: 'agent:cloud:acct_peer',
        kind: 'agent',
        displayName: "Peer Person's Kordi",
        source: 'bridge',
        sourceIdentityId: 'cloud-agent:acct_peer',
        humanId: 'acct_peer',
        ownerIdentityId: 'human:peer',
        sourceHostId: 'cloud',
        agentId: 'cloud-agent:acct_peer',
        avatarKey: 'peer-agent',
        profileImageUrl: null,
        metadata: null,
        createdAtMs: 1,
        updatedAtMs: 1,
      },
    ],
    participants: [],
    messages: [{
      id: 'msg_snapshot_request',
      sessionId: 'session:fork:abc',
      senderIdentityId: 'human:me',
      senderRole: 'user',
      messageKind: 'text',
      contentText: '@PeerPersonKordi hello',
      content: {
        mentions: [{
          targetKind: 'agent',
          sourceHostId: 'cloud',
          humanId: 'acct_peer',
          label: "PeerPerson's Kordi",
        }],
      },
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

test('group progress candidates include the sender, Agent owner, and other members', () => {
  const state = {
    profile: { humanIdentityId: 'human:sender' },
    sessions: [{ id: 'session:group:team', kind: 'group', title: 'Team', status: 'active' }],
    identities: [
      { id: 'human:owner', kind: 'human', humanId: 'owner', displayName: 'Agent Owner' },
      { id: 'agent:cloud-agent:cloud-agent:owner', kind: 'agent', humanId: 'owner',
        agentId: 'cloud-agent:owner', ownerIdentityId: 'human:owner', displayName: 'Renamed Agent', source: 'cloud' },
    ],
    participants: [], delegatedExchanges: [], presence: [], contextSnapshots: [],
    messages: [{
      id: 'request', sessionId: 'session:group:team', senderIdentityId: 'human:sender',
      senderRole: 'user', messageKind: 'text', contentText: '@RenamedAgent hello',
      status: 'sent', sequenceNum: 10, createdAtMs: 10, updatedAtMs: 10,
      content: { mentions: [{
        targetKind: 'agent', sourceHostId: 'cloud', humanId: 'owner',
        agentId: 'cloud-agent:owner', displayLabel: 'Renamed Agent', ownerName: 'Agent Owner',
      }] },
    }],
  } as unknown as CanonicalSessionState;
  const body = encodeCloudGroupControl({
    kind: 'group-message', groupId: 'session:group:team', groupTitle: 'Team', createdByAccountId: 'acct_sender',
    actor: { accountId: 'acct_sender', displayName: 'Sender', role: 'admin' },
    participants: [
      { accountId: 'acct_sender', displayName: 'Sender', role: 'admin' },
      { accountId: 'acct_owner', displayName: 'Agent Owner', role: 'person' },
      { accountId: 'acct_member', displayName: 'Member', role: 'person' },
    ],
    message: { id: 'request', senderAccountId: 'acct_sender', text: '@RenamedAgent hello', createdAtMs: 10,
      targetCloudAgentId: 'cloud-agent:acct_owner', targetCloudAgentOwnerAccountId: 'acct_owner' },
  });
  for (const viewer of ['sender', 'owner', 'member']) {
    state.profile.humanIdentityId = `human:${viewer}`;
    state.messages[0].senderRole = viewer === 'sender' ? 'user' : 'person';
    const candidates = cloudAgentMentionCandidates(state, viewer);
    assert.equal(candidates.length, 1, viewer);
    assert.equal(candidates[0].requestMessage.id, 'request');
    assert.equal(candidates[0].targetAccountId, 'owner');
    assert.equal(candidates[0].targetAgentDisplayName, 'Renamed Agent');
    assert.equal(candidates[0].targetHumanDisplayName, 'Agent Owner');
    const noticeId = 'msg:cloud-agent-processing:request:owner';
    const pendingState = appendCloudGroupRequestingPlaceholder(state, candidates[0], noticeId)!;
    assert.equal(appendCloudGroupRequestingPlaceholder(pendingState, candidates[0], noticeId), pendingState);
    const pending = createCanonicalSessionReadModel(pendingState).messages('session:group:team')
      .filter(message => message.turn && !message.turn.completed);
    assert.equal(pending.length, 1, viewer);
    assert.equal(pending[0].sender, 'Renamed Agent');
    assert.equal(pending[0].senderOwnerName, viewer === 'owner' ? 'You' : 'Agent Owner');
    assert.equal(pending[0].role, viewer === 'owner' ? 'owned-agent' : 'external-agent');
    assert.equal(pending[0].replyToMessageId, 'request');
    const wire: CloudMessage = {
      messageId: 'wire-request', fromAccountId: 'acct_sender', toAccountId: viewer === 'sender' ? 'acct_owner' : `acct_${viewer}`,
      body, createdAt: new Date(10).toISOString(), readAt: null,
      direction: viewer === 'sender' ? 'outgoing' : 'incoming',
    };
    const claims = cloudFallbackRunClaimsForMessages({
      account: { ...account, accountId: `acct_${viewer}` }, contacts: [],
      messagesByPeer: { [viewer === 'sender' ? 'acct_owner' : 'acct_sender']: [wire] },
    });
    assert.equal(claims.length, viewer === 'sender' ? 1 : 0, 'progress observers cannot claim as the requester');
  }
  state.messages[0].senderRole = 'user';
  assert.deepEqual(cloudAgentMentionCandidates(state, 'owner'), [], 'own local requests keep local auth gating');
  state.messages[0].senderRole = 'external-agent';
  assert.deepEqual(cloudAgentMentionCandidates(state, 'member'), []);
  state.messages[0].senderRole = 'person';
  state.messages[0].status = 'failed';
  assert.deepEqual(cloudAgentMentionCandidates(state, 'member'), []);
  state.messages[0].status = 'received';
  const content = state.messages[0].content as Record<string, unknown>;
  content.messageAction = { schemaVersion: 1, kind: 'forward', source: {
    sourceSessionId: 'source', sourceMessageId: 'original', senderLabel: 'Sender',
  } };
  assert.deepEqual(cloudAgentMentionCandidates(state, 'member'), [], 'forwarded mentions are display-only');
  delete content.messageAction;
  state.messages[0].sessionId = 'session:direct-person:sender:owner';
  assert.deepEqual(cloudAgentMentionCandidates(state, 'member'), []);
});
