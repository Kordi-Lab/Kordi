import assert from 'node:assert/strict';
import test from 'node:test';

import {
  collaborationMentionCandidateOptionText,
  buildCollaborationMentionCandidates,
  filterCollaborationMentionCandidatesForConversation,
  filterCollaborationMentionCandidatesForHost,
  localAgentMentionLabels,
  mentionHandleForLabel,
  mentionsLocalAgent,
  shouldIncludeLocalAgentMentionForConversation,
  mentionScopeConversationForActiveConversation,
  outreachIdentityForCollaborationTarget,
  publicLocalAgentMentionText,
  resolveMentionedCollaborationAgentTargetWithSharedCloudAgentRefresh,
  resolveMentionedCollaborationTarget,
} from '../src/features/chat/messageActions/mentions';
import type { Conversation, DesktopCollaborationPeer, DesktopCollaborationState, DesktopChatState } from '../src/kordi-app/types';

function peer(overrides: Partial<DesktopCollaborationPeer> & Pick<DesktopCollaborationPeer, 'nodeId' | 'runtime'>): DesktopCollaborationPeer {
  return {
    endpoint: `https://${overrides.nodeId}.example`,
    sharedProjects: [],
    isContact: true,
    contactRequestStatus: 'approved',
    ...overrides,
  };
}

function bridgeStateWithPeers(peers: DesktopCollaborationPeer[]): DesktopCollaborationState {
  return {
    conversations: [],
    activeHostId: 'host-1',
    hosts: [{
      id: 'host-1',
      registered: true,
      connected: true,
      serverUrl: 'http://127.0.0.1:1234',
      displayName: 'Host One',
      ownerName: 'Host Owner',
      endpoint: 'https://host.example',
      tokenPresent: true,
      humanId: 'host-human-1',
      discoveryMode: 'manual',
      nodeId: 'host-node-1',
      activeAgentId: 'agent-local',
      agents: [{
        id: 'agent-local',
        nodeId: 'local-node-1',
        label: "Owner's Kordi",
        runtime: 'kordi-local',
        isDefault: true,
        isActive: true,
        registered: true,
      }],
      visiblePeers: peers,
      visiblePeerCount: peers.length,
      projects: [],
    }],
  };
}

function groupConversationWithHumans(humans: Array<{ id: string; name: string; humanId: string; sourceIdentityId: string }>): Conversation {
  return {
    id: 'session:group:test',
    canonicalSessionId: 'session:group:test',
    name: 'Group',
    type: 'owned-agent',
    subtitle: '',
    unread: 0,
    collaborationSources: ['Bridge'],
    trust: 'Bridge',
    directness: 'Group chat',
    participants: ['Host Owner', ...humans.map((human) => human.name)],
    participantSpaceId: 'group:test',
    canonicalParticipants: [
      {
        id: 'human:host',
        name: 'Host Owner',
        kind: 'human',
        role: 'self',
        source: 'bridge',
        humanId: 'human-host',
        sourceIdentityId: 'host-node-1',
      },
      ...humans.map((human) => ({
        id: human.id,
        name: human.name,
        kind: 'human' as const,
        role: 'person',
        source: 'bridge',
        humanId: human.humanId,
        sourceIdentityId: human.sourceIdentityId,
      })),
    ],
    messages: [],
  } as Conversation;
}

function groupConversationWithParticipantNames(names: string[]): Conversation {
  return {
    id: 'session:group:fallback',
    canonicalSessionId: 'session:group:fallback',
    name: 'Group',
    type: 'owned-agent',
    subtitle: '',
    unread: 0,
    collaborationSources: ['Bridge'],
    trust: 'Bridge',
    directness: 'Group chat',
    participants: names,
    messages: [],
  } as Conversation;
}

function directPersonConversationWithHuman(human: { id: string; name: string; humanId: string; sourceIdentityId: string }): Conversation {
  return {
    id: 'session:direct-person:test',
    canonicalSessionId: 'session:direct-person:test',
    name: human.name,
    type: 'person',
    subtitle: '',
    unread: 0,
    collaborationSources: ['Bridge'],
    trust: 'Bridge',
    directness: 'Direct person chat',
    participants: ['Host Owner', human.name],
    canonicalParticipants: [
      {
        id: 'human:host',
        name: 'Host Owner',
        kind: 'human',
        role: 'self',
        source: 'bridge',
        humanId: 'host-human-1',
        sourceIdentityId: 'host-node-1',
      },
      {
        id: human.id,
        name: human.name,
        kind: 'human',
        role: 'person',
        source: 'bridge',
        humanId: human.humanId,
        sourceIdentityId: human.sourceIdentityId,
      },
    ],
    messages: [],
  } as Conversation;
}

test('mentionHandleForLabel keeps only unicode letters and numbers', () => {
  assert.equal(mentionHandleForLabel("Alice's Kordi"), 'AlicesKordi');
  assert.equal(mentionHandleForLabel('Ann Lee'), 'AnnLee');
  assert.equal(mentionHandleForLabel('Équipe Démo 42'), 'ÉquipeDémo42');
  assert.equal(mentionHandleForLabel('!!!', 'node-123'), 'node123');
});

test('buildCollaborationMentionCandidates creates unique stable handles for sanitized collisions', () => {
  const collaborationState = bridgeStateWithPeers([
    peer({
      nodeId: 'node-alpha-111',
      displayName: 'Ann Lee',
      ownerName: 'Ann Lee',
      runtime: 'person',
      humanId: 'human-alpha-222',
      agentId: null,
      isDefaultAgent: false,
    }),
    peer({
      nodeId: 'node-beta-333',
      displayName: 'Ann-Lee',
      ownerName: 'Ann-Lee',
      runtime: 'person',
      humanId: 'human-beta-444',
      agentId: null,
      isDefaultAgent: false,
    }),
  ]);

  const annCandidates = buildCollaborationMentionCandidates(collaborationState)
    .filter((candidate) => candidate.targetKind === 'person' && candidate.displayLabel.startsWith('Ann'));

  assert.equal(annCandidates.length, 2);
  assert.deepEqual(
    annCandidates.map((candidate) => candidate.handle).sort(),
    ['AnnLeehumanalp', 'AnnLeehumanbet'].sort(),
  );
});

test('bridge mention option text shows display names with product-facing detail labels', () => {
  const collaborationState = bridgeStateWithPeers([
    peer({
      nodeId: 'kd_remote_node_123',
      displayName: "Alice's Kordi",
      ownerName: 'Alice',
      runtime: 'kordi-desktop',
      humanId: 'human-alice',
      agentId: 'agent-alice',
      isDefaultAgent: true,
    }),
  ]);

  const options = buildCollaborationMentionCandidates(collaborationState).map(collaborationMentionCandidateOptionText);

  assert.deepEqual(options, [
    {
      label: 'Alice',
      detail: 'Person',
    },
    {
      label: "Alice's Kordi",
      detail: 'Agent',
    },
  ]);
  assert.equal(options.some((option) => option.detail.includes('Host One')), false);
  assert.equal(options.some((option) => option.label === 'AlicesKordi'), false);
});

test('owner-only bridge agents are hidden from mention candidates while their default owner person stays mentionable', () => {
  const collaborationState = bridgeStateWithPeers([
    peer({
      nodeId: 'kd_owner_only',
      displayName: "Alice's Kordi",
      ownerName: 'Alice',
      runtime: 'kordi-desktop',
      humanId: 'human-alice',
      agentId: 'agent-alice',
      isDefaultAgent: true,
      agentReachabilityPolicy: 'owner',
    }),
    peer({
      nodeId: 'kd_private_helper',
      displayName: 'Private Helper',
      ownerName: 'Alice',
      runtime: 'kordi-desktop',
      humanId: 'human-alice',
      agentId: 'agent-private',
      isDefaultAgent: false,
      agentReachabilityPolicy: 'owner',
    }),
  ]);

  assert.deepEqual(
    buildCollaborationMentionCandidates(collaborationState).map((candidate) => `${candidate.targetKind}:${candidate.displayLabel}`),
    ['person:Alice'],
  );
});

test('group mention candidates include group people and approved agents, not outside contacts or non-contact agents', () => {
  const collaborationState = bridgeStateWithPeers([
    peer({
      nodeId: 'node-alice-agent',
      displayName: "Alice's Kordi",
      ownerName: 'Alice',
      runtime: 'kordi-desktop',
      humanId: 'human-alice',
      agentId: 'agent-alice',
      isDefaultAgent: true,
      isContact: true,
      contactRequestStatus: 'approved',
    }),
    peer({
      nodeId: 'node-bob-agent',
      displayName: "Bob's Kordi",
      ownerName: 'Bob',
      runtime: 'kordi-desktop',
      humanId: 'human-bob',
      agentId: 'agent-bob',
      isDefaultAgent: true,
      isContact: false,
      contactRequestStatus: null,
    }),
    peer({
      nodeId: 'node-carol-agent',
      displayName: "Carol's Kordi",
      ownerName: 'Carol',
      runtime: 'kordi-desktop',
      humanId: 'human-carol',
      agentId: 'agent-carol',
      isDefaultAgent: true,
    }),
  ]);
  const group = groupConversationWithHumans([
    { id: 'human:alice', name: 'Alice', humanId: 'human-alice', sourceIdentityId: 'node-alice-person' },
    { id: 'human:bob', name: 'Bob', humanId: 'human-bob', sourceIdentityId: 'node-bob-person' },
  ]);

  const scoped = filterCollaborationMentionCandidatesForConversation(buildCollaborationMentionCandidates(collaborationState), group);

  assert.deepEqual(
    scoped.map((candidate) => `${candidate.targetKind}:${candidate.displayLabel}`),
    ['person:Alice', "agent:Alice's Kordi", 'person:Bob'],
  );
});

test('participant scoped chats keep the local agent mentionable when self metadata is missing', () => {
  const direct = directPersonConversationWithHuman({
    id: 'human:bob',
    name: 'Bob',
    humanId: 'human-bob',
    sourceIdentityId: 'node-bob-person',
  });
  direct.participants = ['Bob'];
  direct.canonicalParticipants = direct.canonicalParticipants?.filter((participant) => participant.role !== 'self');

  assert.equal(
    shouldIncludeLocalAgentMentionForConversation(direct, { humanId: 'host-human-1', ownerName: 'Host Owner' }),
    true,
  );
});

test('direct person mention candidates include only the contact and their agents', () => {
  const collaborationState = bridgeStateWithPeers([
    peer({
      nodeId: 'node-alice-agent',
      displayName: "Alice's Kordi",
      ownerName: 'Alice',
      runtime: 'kordi-desktop',
      humanId: 'human-alice',
      agentId: 'agent-alice',
      isDefaultAgent: true,
    }),
    peer({
      nodeId: 'node-bob-agent',
      displayName: "Bob's Kordi",
      ownerName: 'Bob',
      runtime: 'kordi-desktop',
      humanId: 'human-bob',
      agentId: 'agent-bob',
      isDefaultAgent: true,
    }),
    peer({
      nodeId: 'node-carol-agent',
      displayName: "Carol's Kordi",
      ownerName: 'Carol',
      runtime: 'kordi-desktop',
      humanId: 'human-carol',
      agentId: 'agent-carol',
      isDefaultAgent: true,
    }),
  ]);
  const direct = directPersonConversationWithHuman({
    id: 'human:bob',
    name: 'Bob',
    humanId: 'human-bob',
    sourceIdentityId: 'node-bob-person',
  });

  const scoped = filterCollaborationMentionCandidatesForConversation(buildCollaborationMentionCandidates(collaborationState), direct);

  assert.deepEqual(
    scoped.map((candidate) => `${candidate.targetKind}:${candidate.displayLabel}`),
    ['person:Bob', "agent:Bob's Kordi"],
  );
});

test('group mention candidates fall back to participant names when canonical details are missing', () => {
  const collaborationState = bridgeStateWithPeers([
    peer({
      nodeId: 'node-alice-agent',
      displayName: "Alice's Kordi",
      ownerName: 'Alice',
      runtime: 'kordi-desktop',
      humanId: 'human-alice',
      agentId: 'agent-alice',
      isDefaultAgent: true,
    }),
    peer({
      nodeId: 'node-bob-agent',
      displayName: "Bob's Kordi",
      ownerName: 'Bob',
      runtime: 'kordi-desktop',
      humanId: 'human-bob',
      agentId: 'agent-bob',
      isDefaultAgent: true,
    }),
    peer({
      nodeId: 'node-carol-agent',
      displayName: "Carol's Kordi",
      ownerName: 'Carol',
      runtime: 'kordi-desktop',
      humanId: 'human-carol',
      agentId: 'agent-carol',
      isDefaultAgent: true,
    }),
  ]);
  const group = groupConversationWithParticipantNames(['Host Owner', 'Alice', 'Bob']);

  const scoped = filterCollaborationMentionCandidatesForConversation(buildCollaborationMentionCandidates(collaborationState), group);

  assert.deepEqual(
    scoped.map((candidate) => `${candidate.targetKind}:${candidate.displayLabel}`),
    ['person:Alice', "agent:Alice's Kordi", 'person:Bob', "agent:Bob's Kordi"],
  );
});

test('group mention scope uses root group participants for legacy child continuations', () => {
  const collaborationState = bridgeStateWithPeers([
    peer({
      nodeId: 'node-alice-agent',
      displayName: "Alice's Kordi",
      ownerName: 'Alice',
      runtime: 'kordi-desktop',
      humanId: 'human-alice',
      agentId: 'agent-alice',
      isDefaultAgent: true,
    }),
    peer({
      nodeId: 'node-bob-agent',
      displayName: "Bob's Kordi",
      ownerName: 'Bob',
      runtime: 'kordi-desktop',
      humanId: 'human-bob',
      agentId: 'agent-bob',
      isDefaultAgent: true,
    }),
    peer({
      nodeId: 'node-carol-agent',
      displayName: "Carol's Kordi",
      ownerName: 'Carol',
      runtime: 'kordi-desktop',
      humanId: 'human-carol',
      agentId: 'agent-carol',
      isDefaultAgent: true,
    }),
  ]);
  const root = {
    ...groupConversationWithHumans([
      { id: 'human:alice', name: 'Alice', humanId: 'human-alice', sourceIdentityId: 'node-alice-person' },
      { id: 'human:bob', name: 'Bob', humanId: 'human-bob', sourceIdentityId: 'node-bob-person' },
    ]),
    id: 'session:group:root',
    canonicalSessionId: 'session:group:root',
  } as Conversation;
  const child = {
    ...groupConversationWithHumans([
      { id: 'human:alice', name: 'Alice', humanId: 'human-alice', sourceIdentityId: 'node-alice-person' },
      { id: 'human:bob', name: 'Bob', humanId: 'human-bob', sourceIdentityId: 'node-bob-person' },
      { id: 'human:carol', name: 'Carol', humanId: 'human-carol', sourceIdentityId: 'node-carol-person' },
    ]),
    id: 'session:group:child',
    canonicalSessionId: 'session:group:child',
    metadata: { continuedFromSessionId: 'session:group:root' },
  } as Conversation;

  const scope = mentionScopeConversationForActiveConversation(child, [child, root]);
  const scoped = filterCollaborationMentionCandidatesForConversation(buildCollaborationMentionCandidates(collaborationState), scope);

  assert.deepEqual(
    scoped.map((candidate) => `${candidate.targetKind}:${candidate.displayLabel}`),
    ['person:Alice', "agent:Alice's Kordi", 'person:Bob', "agent:Bob's Kordi"],
  );
});

test('group mention scope keeps active child participants when legacy root has no participant details', () => {
  const root = {
    ...groupConversationWithParticipantNames(['Host Owner', 'Alice', 'Bob']),
    id: 'session:group:root-empty',
    canonicalSessionId: 'session:group:root-empty',
    canonicalParticipants: [],
  } as Conversation;
  const child = {
    ...groupConversationWithHumans([
      { id: 'human:alice', name: 'Alice', humanId: 'human-alice', sourceIdentityId: 'node-alice-person' },
      { id: 'human:bob', name: 'Bob', humanId: 'human-bob', sourceIdentityId: 'node-bob-person' },
    ]),
    id: 'session:group:child-with-participants',
    canonicalSessionId: 'session:group:child-with-participants',
    metadata: { continuedFromSessionId: 'session:group:root-empty' },
  } as Conversation;

  const scope = mentionScopeConversationForActiveConversation(child, [child, root]);

  assert.equal(scope.canonicalParticipants?.length, 3);
  assert.deepEqual(scope.canonicalParticipants?.map((participant) => participant.name), ['Host Owner', 'Alice', 'Bob']);
});

test('group mention candidates hide non-contact contacts-only agents while keeping the person mentionable', () => {
  const collaborationState = bridgeStateWithPeers([
    peer({
      nodeId: 'node-bob-agent',
      displayName: "Bob's Kordi",
      ownerName: 'Bob',
      runtime: 'kordi-desktop',
      humanId: 'human-bob',
      agentId: 'agent-bob',
      isDefaultAgent: true,
      isContact: false,
      contactRequestStatus: null,
      agentReachabilityPolicy: 'contacts',
    }),
  ]);
  const group = groupConversationWithHumans([
    { id: 'human:bob', name: 'Bob', humanId: 'human-bob', sourceIdentityId: 'node-bob-agent' },
  ]);

  const scoped = filterCollaborationMentionCandidatesForConversation(buildCollaborationMentionCandidates(collaborationState), group);

  assert.deepEqual(
    scoped.map((candidate) => `${candidate.targetKind}:${candidate.displayLabel}`),
    ['person:Bob'],
  );
});

test('group mention candidates include server-reachable agents even without contact approval', () => {
  const collaborationState = bridgeStateWithPeers([
    peer({
      nodeId: 'node-bob-agent',
      displayName: "Bob's Kordi",
      ownerName: 'Bob',
      runtime: 'kordi-desktop',
      humanId: 'human-bob',
      agentId: 'agent-bob',
      isDefaultAgent: true,
      isContact: false,
      contactRequestStatus: null,
      agentReachabilityPolicy: 'server',
    }),
  ]);
  const group = groupConversationWithHumans([
    { id: 'human:bob', name: 'Bob', humanId: 'human-bob', sourceIdentityId: 'node-bob-agent' },
  ]);

  const scoped = filterCollaborationMentionCandidatesForConversation(buildCollaborationMentionCandidates(collaborationState), group);

  assert.deepEqual(
    scoped.map((candidate) => `${candidate.targetKind}:${candidate.displayLabel}`),
    ['person:Bob', "agent:Bob's Kordi"],
  );
});

test('mention candidates hide active host person and agent duplicates', () => {
  const collaborationState = bridgeStateWithPeers([
    peer({
      nodeId: 'host-node-1',
      displayName: "Host Owner's Kordi",
      ownerName: 'Host Owner',
      runtime: 'kordi-desktop',
      humanId: 'host-human-1',
      agentId: 'agent-local',
      isDefaultAgent: true,
    }),
    peer({
      nodeId: 'node-alice-agent',
      displayName: "Alice's Kordi",
      ownerName: 'Alice',
      runtime: 'kordi-desktop',
      humanId: 'human-alice',
      agentId: 'agent-alice',
      isDefaultAgent: true,
    }),
  ]);

  const candidates = filterCollaborationMentionCandidatesForHost(
    buildCollaborationMentionCandidates(collaborationState),
    collaborationState.hosts[0],
  );

  assert.deepEqual(
    candidates.map((candidate) => `${candidate.targetKind}:${candidate.displayLabel}`),
    ['person:Alice', "agent:Alice's Kordi"],
  );
});

test('send-time group mention action resolves member agents but not people or outside agents', () => {
  const collaborationState = bridgeStateWithPeers([
    peer({
      nodeId: 'node-alice-agent',
      displayName: "Alice's Kordi",
      ownerName: 'Alice',
      runtime: 'kordi-desktop',
      humanId: 'human-alice',
      agentId: 'agent-alice',
      isDefaultAgent: true,
    }),
    peer({
      nodeId: 'node-carol-agent',
      displayName: "Carol's Kordi",
      ownerName: 'Carol',
      runtime: 'kordi-desktop',
      humanId: 'human-carol',
      agentId: 'agent-carol',
      isDefaultAgent: true,
    }),
  ]);
  const group = groupConversationWithHumans([
    { id: 'human:alice', name: 'Alice', humanId: 'human-alice', sourceIdentityId: 'node-alice-person' },
  ]);

  const aliceAgent = resolveMentionedCollaborationTarget('@AlicesKordi please join', collaborationState, group, { targetKind: 'agent' });
  const alicePerson = resolveMentionedCollaborationTarget('@Alice please join', collaborationState, group, { targetKind: 'agent' });
  const carolAgent = resolveMentionedCollaborationTarget('@CarolsKordi please join', collaborationState, group, { targetKind: 'agent' });

  assert.equal(aliceAgent?.targetKind, 'agent');
  assert.equal(aliceAgent?.peer.nodeId, 'node-alice-agent');
  assert.equal(aliceAgent?.requestText, 'please join');
  assert.equal(alicePerson, null);
  assert.equal(carolAgent, null);
});

test('send-time group mention action refreshes shared Cloud Agents before resolving plain text handles', async () => {
  const collaborationState = bridgeStateWithPeers([]);
  const group = groupConversationWithHumans([
    { id: 'human:owner', name: '111', humanId: 'acct_owner', sourceIdentityId: 'acct_owner' },
  ]);
  let refreshCount = 0;

  const target = await resolveMentionedCollaborationAgentTargetWithSharedCloudAgentRefresh(
    '@KordiProjectDriver hi',
    collaborationState,
    group,
    [],
    async () => {
      refreshCount += 1;
      return [{
        agentId: 'cloud_agent_project_driver',
        ownerAccountId: 'acct_owner',
        ownerDisplayName: '111',
        accessScope: 'participant_conversations',
        name: 'Kordi Project Driver',
        role: 'Project driver',
        description: null,
        updatedAt: '2026-06-22T12:00:00Z',
      }];
    },
  );

  assert.equal(refreshCount, 1);
  assert.equal(target?.targetKind, 'agent');
  assert.equal(target?.peer.agentId, 'cloud_agent_project_driver');
  assert.equal(target?.peer.humanId, 'acct_owner');
  assert.equal(target?.displayLabel, 'Kordi Project Driver');
  assert.equal(target?.requestText, 'hi');
});

test('group mention resolution ignores stale same-name agents with a different participant identity', () => {
  const collaborationState = bridgeStateWithPeers([
    peer({
      nodeId: 'node-stale-alice-agent',
      displayName: "Alice's Kordi",
      ownerName: 'Alice',
      runtime: 'kordi-desktop',
      humanId: 'human-old-alice',
      agentId: 'agent-old-alice',
      isDefaultAgent: true,
    }),
    peer({
      nodeId: 'node-current-alice-agent',
      displayName: "Alice's Kordi",
      ownerName: 'Alice',
      runtime: 'kordi-desktop',
      humanId: 'human-current-alice',
      agentId: 'agent-current-alice',
      isDefaultAgent: true,
    }),
  ]);
  const group = groupConversationWithHumans([
    { id: 'human:alice-current', name: 'Alice', humanId: 'human-current-alice', sourceIdentityId: 'node-current-alice-agent' },
  ]);

  const target = resolveMentionedCollaborationTarget('@AlicesKordi please check this', collaborationState, group, { targetKind: 'agent' });

  assert.equal(target?.peer.nodeId, 'node-current-alice-agent');
  assert.equal(target?.peer.humanId, 'human-current-alice');
});

test('buildCollaborationMentionCandidates does not expose node id duplicates when friendly labels exist', () => {
  const collaborationState = bridgeStateWithPeers([
    peer({
      nodeId: 'kd_remote_node_123',
      displayName: "Alice's Kordi",
      ownerName: 'Alice',
      runtime: 'kordi-local',
      humanId: 'human-alice',
      agentId: 'agent-alice',
      isDefaultAgent: true,
    }),
  ]);

  const candidates = buildCollaborationMentionCandidates(collaborationState);

  assert.deepEqual(
    candidates.map((candidate) => `${candidate.targetKind}:${candidate.displayLabel}`),
    ['person:Alice', "agent:Alice's Kordi"],
  );
  assert.equal(candidates.some((candidate) => candidate.displayLabel === 'kd_remote_node_123'), false);
});

test('buildCollaborationMentionCandidates does not duplicate a person from their paired agent peer', () => {
  const collaborationState = bridgeStateWithPeers([
    peer({
      nodeId: 'acct_alice',
      displayName: 'Alice',
      ownerName: 'Alice',
      runtime: 'person',
      humanId: 'acct_alice',
      agentId: null,
      isDefaultAgent: false,
    }),
    peer({
      nodeId: 'cloud-agent:acct_alice',
      displayName: "Alice's Kordi",
      ownerName: 'Alice',
      runtime: 'kordi-desktop',
      humanId: 'acct_alice',
      agentId: 'cloud-agent:acct_alice',
      isDefaultAgent: true,
    }),
  ]);

  const candidates = buildCollaborationMentionCandidates(collaborationState);

  assert.deepEqual(
    candidates.map((candidate) => `${candidate.targetKind}:${candidate.displayLabel}`),
    ['person:Alice', "agent:Alice's Kordi"],
  );
});

test('buildCollaborationMentionCandidates falls back to node id when no friendly labels exist', () => {
  const collaborationState = bridgeStateWithPeers([
    peer({
      nodeId: 'kd_unlabeled_node_123',
      displayName: null,
      ownerName: null,
      runtime: 'kordi-local',
      humanId: null,
      agentId: null,
      isDefaultAgent: false,
    }),
  ]);

  const candidates = buildCollaborationMentionCandidates(collaborationState);

  assert.deepEqual(
    candidates.map((candidate) => `${candidate.targetKind}:${candidate.displayLabel}`),
    ['agent:kd_unlabeled_node_123'],
  );
});

test('resolveMentionedCollaborationTarget uses the same unique handle as autocomplete candidates', () => {
  const collaborationState = bridgeStateWithPeers([
    peer({
      nodeId: 'node-alpha-111',
      displayName: 'Ann Lee',
      ownerName: 'Ann Lee',
      runtime: 'person',
      humanId: 'human-alpha-222',
      agentId: null,
      isDefaultAgent: false,
    }),
    peer({
      nodeId: 'node-beta-333',
      displayName: 'Ann-Lee',
      ownerName: 'Ann-Lee',
      runtime: 'person',
      humanId: 'human-beta-444',
      agentId: null,
      isDefaultAgent: false,
    }),
  ]);

  const target = resolveMentionedCollaborationTarget('@AnnLeehumanbet please review', collaborationState);

  assert.equal(target?.peer.nodeId, 'node-beta-333');
  assert.equal(target?.label, 'AnnLeehumanbet');
  assert.equal(target?.displayLabel, 'Ann-Lee');
  assert.equal(target?.requestText, 'please review');
});

test('outreach identity preserves display label while mention metadata stores safe handle', () => {
  const collaborationState = bridgeStateWithPeers([
    peer({
      nodeId: 'node-kordi-1',
      displayName: "Alice's Kordi",
      ownerName: 'Alice',
      runtime: 'kordi-local',
      humanId: 'human-alice',
      agentId: 'agent-alice',
      isDefaultAgent: true,
    }),
  ]);

  const target = resolveMentionedCollaborationTarget('@AlicesKordi summarize this', collaborationState);
  assert.ok(target);
  assert.equal(target.label, 'AlicesKordi');
  assert.equal(target.displayLabel, "Alice's Kordi");
  assert.equal(outreachIdentityForCollaborationTarget(target).targetDisplayName, "Alice's Kordi");
});

test('legacy display-label matching works only when unambiguous', () => {
  const unambiguousState = bridgeStateWithPeers([
    peer({
      nodeId: 'node-alice-1',
      displayName: "Alice's Kordi",
      ownerName: 'Alice',
      runtime: 'kordi-local',
      humanId: 'human-alice',
      agentId: 'agent-alice',
      isDefaultAgent: true,
    }),
  ]);

  assert.equal(
    resolveMentionedCollaborationTarget("@Alice's Kordi summarize", unambiguousState)?.peer.nodeId,
    'node-alice-1',
  );

  const ambiguousState = bridgeStateWithPeers([
    peer({
      nodeId: 'node-a-1',
      displayName: "Alice's Kordi",
      ownerName: 'Alice',
      runtime: 'kordi-local',
      humanId: 'human-a',
      agentId: 'agent-a',
      isDefaultAgent: true,
    }),
    peer({
      nodeId: 'node-a-2',
      displayName: "Alice's Kordi",
      ownerName: 'Alice',
      runtime: 'kordi-local',
      humanId: 'human-b',
      agentId: 'agent-b',
      isDefaultAgent: true,
    }),
  ]);

  assert.equal(resolveMentionedCollaborationTarget("@Alice's Kordi summarize", ambiguousState), null);
});

test('publicLocalAgentMentionText rewrites first-person agent mentions for remote viewers', () => {
  assert.equal(
    publicLocalAgentMentionText('@MyKordi show me the diskusage', bridgeStateWithPeers([])),
    '@HostOwnersKordi show me the diskusage',
  );
  assert.equal(
    publicLocalAgentMentionText('@Kordi: summarize this', bridgeStateWithPeers([])),
    '@HostOwnersKordi summarize this',
  );
});

test('local agent labels include sanitized aliases', () => {
  const chatState = {
    localAgent: {
      label: "Owner's Kordi",
      workspaceRoot: '/Users/example/My Project',
    },
  } as DesktopChatState;

  assert.deepEqual(
    localAgentMentionLabels(chatState, bridgeStateWithPeers([])),
    ['Kordi', 'OwnersKordi', 'MyKordi', 'MyOwnersKordi', 'HostOwnersKordi', 'HostOwnersOwnersKordi', 'agentlocal', 'localnode1', 'MyProject'],
  );
});

test('mentionsLocalAgent does not treat the local human display name as an agent mention', () => {
  const collaborationState = bridgeStateWithPeers([]);
  collaborationState.hosts[0].displayName = 'Shuyheretest';
  collaborationState.hosts[0].ownerName = 'Shuyheretest';
  collaborationState.hosts[0].agents[0].label = 'Kordi';

  assert.equal(mentionsLocalAgent('@Shuyheretest hi', null, collaborationState), false);
  assert.equal(mentionsLocalAgent('@ShuyheretestsKordi hi', null, collaborationState), true);
});
