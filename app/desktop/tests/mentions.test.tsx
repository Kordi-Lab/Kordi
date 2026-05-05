import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bridgeMentionCandidateOptionText,
  buildBridgeMentionCandidates,
  filterBridgeMentionCandidatesForConversation,
  filterBridgeMentionCandidatesForHost,
  localAgentMentionLabels,
  mentionHandleForLabel,
  shouldIncludeLocalAgentMentionForConversation,
  mentionScopeConversationForActiveConversation,
  outreachIdentityForBridgeTarget,
  publicLocalAgentMentionText,
  resolveMentionedBridgeTarget,
} from '../src/features/chat/messageActions/mentions';
import {
  initiatorIdentityForOutreach,
  selfTargetIdentityForMentionedBridgeTarget,
} from '../src/features/chat/messageActions/context';
import type { Conversation, DesktopBridgePeer, DesktopBridgeState, DesktopChatState } from '../src/kordi-app/types';

function peer(overrides: Partial<DesktopBridgePeer> & Pick<DesktopBridgePeer, 'nodeId' | 'runtime'>): DesktopBridgePeer {
  return {
    endpoint: `https://${overrides.nodeId}.example`,
    sharedProjects: [],
    ...overrides,
  };
}

function bridgeStateWithPeers(peers: DesktopBridgePeer[]): DesktopBridgeState {
  return {
    configPath: '/tmp/bridges.json',
    legacyConfigPath: '/tmp/legacy-bridges.json',
    conversationsPath: '/tmp/conversations.json',
    conversations: [],
    localServer: { running: true, serverUrl: 'http://127.0.0.1:1234' },
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

function groupConversationWithHumans(humans: Array<{ id: string; name: string; humanId: string; bridgeNodeId: string }>): Conversation {
  return {
    id: 'session:group:test',
    canonicalSessionId: 'session:group:test',
    name: 'Group',
    type: 'owned-agent',
    subtitle: '',
    unread: 0,
    bridges: ['Bridge'],
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
        bridgeNodeId: 'host-node-1',
      },
      ...humans.map((human) => ({
        id: human.id,
        name: human.name,
        kind: 'human' as const,
        role: 'person',
        source: 'bridge',
        humanId: human.humanId,
        bridgeNodeId: human.bridgeNodeId,
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
    bridges: ['Bridge'],
    trust: 'Bridge',
    directness: 'Group chat',
    participants: names,
    messages: [],
  } as Conversation;
}

function directPersonConversationWithHuman(human: { id: string; name: string; humanId: string; bridgeNodeId: string }): Conversation {
  return {
    id: 'session:direct-person:test',
    canonicalSessionId: 'session:direct-person:test',
    name: human.name,
    type: 'person',
    subtitle: '',
    unread: 0,
    bridges: ['Bridge'],
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
        bridgeNodeId: 'host-node-1',
      },
      {
        id: human.id,
        name: human.name,
        kind: 'human',
        role: 'person',
        source: 'bridge',
        humanId: human.humanId,
        bridgeNodeId: human.bridgeNodeId,
      },
    ],
    messages: [],
  } as Conversation;
}

test('mentionHandleForLabel keeps only unicode letters and numbers', () => {
  assert.equal(mentionHandleForLabel("Alice's Kordi"), 'AlicesKordi');
  assert.equal(mentionHandleForLabel('Ann Lee'), 'AnnLee');
  assert.equal(mentionHandleForLabel('開発 チーム 42'), '開発チーム42');
  assert.equal(mentionHandleForLabel('!!!', 'node-123'), 'node123');
});

test('buildBridgeMentionCandidates creates unique stable handles for sanitized collisions', () => {
  const bridgeState = bridgeStateWithPeers([
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

  const annCandidates = buildBridgeMentionCandidates(bridgeState)
    .filter((candidate) => candidate.targetKind === 'bridge-person' && candidate.displayLabel.startsWith('Ann'));

  assert.equal(annCandidates.length, 2);
  assert.deepEqual(
    annCandidates.map((candidate) => candidate.handle).sort(),
    ['AnnLeehumanalp', 'AnnLeehumanbet'].sort(),
  );
});

test('bridge mention option text shows display names and pairs people with their Kordi', () => {
  const bridgeState = bridgeStateWithPeers([
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

  const options = buildBridgeMentionCandidates(bridgeState).map(bridgeMentionCandidateOptionText);

  assert.deepEqual(options, [
    {
      label: 'Alice',
      detail: "Bridge person • @Alice • Kordi: Alice's Kordi • kordi-desktop",
    },
    {
      label: "Alice's Kordi",
      detail: 'Bridge agent • @AlicesKordi • Owner: Alice • kordi-desktop',
    },
  ]);
  assert.equal(options.some((option) => option.detail.includes('Host One')), false);
  assert.equal(options.some((option) => option.label === 'AlicesKordi'), false);
});

test('group mention candidates include only people in the group and their agents', () => {
  const bridgeState = bridgeStateWithPeers([
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
  const group = groupConversationWithHumans([
    { id: 'human:alice', name: 'Alice', humanId: 'human-alice', bridgeNodeId: 'node-alice-person' },
    { id: 'human:bob', name: 'Bob', humanId: 'human-bob', bridgeNodeId: 'node-bob-person' },
  ]);

  const scoped = filterBridgeMentionCandidatesForConversation(buildBridgeMentionCandidates(bridgeState), group);

  assert.deepEqual(
    scoped.map((candidate) => `${candidate.targetKind}:${candidate.displayLabel}`),
    ['bridge-person:Alice', "bridge-agent:Alice's Kordi", 'bridge-person:Bob', "bridge-agent:Bob's Kordi"],
  );
});

test('participant scoped chats keep the local agent mentionable when self metadata is missing', () => {
  const direct = directPersonConversationWithHuman({
    id: 'human:bob',
    name: 'Bob',
    humanId: 'human-bob',
    bridgeNodeId: 'node-bob-person',
  });
  direct.participants = ['Bob'];
  direct.canonicalParticipants = direct.canonicalParticipants?.filter((participant) => participant.role !== 'self');

  assert.equal(
    shouldIncludeLocalAgentMentionForConversation(direct, { humanId: 'host-human-1', ownerName: 'Host Owner' }),
    true,
  );
});

test('direct person mention candidates include only the contact and their agents', () => {
  const bridgeState = bridgeStateWithPeers([
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
    bridgeNodeId: 'node-bob-person',
  });

  const scoped = filterBridgeMentionCandidatesForConversation(buildBridgeMentionCandidates(bridgeState), direct);

  assert.deepEqual(
    scoped.map((candidate) => `${candidate.targetKind}:${candidate.displayLabel}`),
    ['bridge-person:Bob', "bridge-agent:Bob's Kordi"],
  );
});

test('group mention candidates fall back to participant names when canonical details are missing', () => {
  const bridgeState = bridgeStateWithPeers([
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

  const scoped = filterBridgeMentionCandidatesForConversation(buildBridgeMentionCandidates(bridgeState), group);

  assert.deepEqual(
    scoped.map((candidate) => `${candidate.targetKind}:${candidate.displayLabel}`),
    ['bridge-person:Alice', "bridge-agent:Alice's Kordi", 'bridge-person:Bob', "bridge-agent:Bob's Kordi"],
  );
});

test('group mention scope uses root group participants for legacy child continuations', () => {
  const bridgeState = bridgeStateWithPeers([
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
      { id: 'human:alice', name: 'Alice', humanId: 'human-alice', bridgeNodeId: 'node-alice-person' },
      { id: 'human:bob', name: 'Bob', humanId: 'human-bob', bridgeNodeId: 'node-bob-person' },
    ]),
    id: 'session:group:root',
    canonicalSessionId: 'session:group:root',
  } as Conversation;
  const child = {
    ...groupConversationWithHumans([
      { id: 'human:alice', name: 'Alice', humanId: 'human-alice', bridgeNodeId: 'node-alice-person' },
      { id: 'human:bob', name: 'Bob', humanId: 'human-bob', bridgeNodeId: 'node-bob-person' },
      { id: 'human:carol', name: 'Carol', humanId: 'human-carol', bridgeNodeId: 'node-carol-person' },
    ]),
    id: 'session:group:child',
    canonicalSessionId: 'session:group:child',
    metadata: { continuedFromSessionId: 'session:group:root' },
  } as Conversation;

  const scope = mentionScopeConversationForActiveConversation(child, [child, root]);
  const scoped = filterBridgeMentionCandidatesForConversation(buildBridgeMentionCandidates(bridgeState), scope);

  assert.deepEqual(
    scoped.map((candidate) => `${candidate.targetKind}:${candidate.displayLabel}`),
    ['bridge-person:Alice', "bridge-agent:Alice's Kordi", 'bridge-person:Bob', "bridge-agent:Bob's Kordi"],
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
      { id: 'human:alice', name: 'Alice', humanId: 'human-alice', bridgeNodeId: 'node-alice-person' },
      { id: 'human:bob', name: 'Bob', humanId: 'human-bob', bridgeNodeId: 'node-bob-person' },
    ]),
    id: 'session:group:child-with-participants',
    canonicalSessionId: 'session:group:child-with-participants',
    metadata: { continuedFromSessionId: 'session:group:root-empty' },
  } as Conversation;

  const scope = mentionScopeConversationForActiveConversation(child, [child, root]);

  assert.equal(scope.canonicalParticipants?.length, 3);
  assert.deepEqual(scope.canonicalParticipants?.map((participant) => participant.name), ['Host Owner', 'Alice', 'Bob']);
});

test('mention candidates hide active host person and agent duplicates', () => {
  const bridgeState = bridgeStateWithPeers([
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

  const candidates = filterBridgeMentionCandidatesForHost(
    buildBridgeMentionCandidates(bridgeState),
    bridgeState.hosts[0],
  );

  assert.deepEqual(
    candidates.map((candidate) => `${candidate.targetKind}:${candidate.displayLabel}`),
    ['bridge-person:Alice', "bridge-agent:Alice's Kordi"],
  );
});

test('send-time group mention action resolves member agents but not people or outside agents', () => {
  const bridgeState = bridgeStateWithPeers([
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
    { id: 'human:alice', name: 'Alice', humanId: 'human-alice', bridgeNodeId: 'node-alice-person' },
  ]);

  const aliceAgent = resolveMentionedBridgeTarget('@AlicesKordi please join', bridgeState, group, { targetKind: 'bridge-agent' });
  const alicePerson = resolveMentionedBridgeTarget('@Alice please join', bridgeState, group, { targetKind: 'bridge-agent' });
  const carolAgent = resolveMentionedBridgeTarget('@CarolsKordi please join', bridgeState, group, { targetKind: 'bridge-agent' });

  assert.equal(aliceAgent?.targetKind, 'bridge-agent');
  assert.equal(aliceAgent?.peer.nodeId, 'node-alice-agent');
  assert.equal(aliceAgent?.requestText, 'please join');
  assert.equal(alicePerson, null);
  assert.equal(carolAgent, null);
});

test('group mention resolution ignores stale same-name agents with a different participant identity', () => {
  const bridgeState = bridgeStateWithPeers([
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
    { id: 'human:alice-current', name: 'Alice', humanId: 'human-current-alice', bridgeNodeId: 'node-current-alice-agent' },
  ]);

  const target = resolveMentionedBridgeTarget('@AlicesKordi please check this', bridgeState, group, { targetKind: 'bridge-agent' });

  assert.equal(target?.peer.nodeId, 'node-current-alice-agent');
  assert.equal(target?.peer.humanId, 'human-current-alice');
});

test('buildBridgeMentionCandidates does not expose node id duplicates when friendly labels exist', () => {
  const bridgeState = bridgeStateWithPeers([
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

  const candidates = buildBridgeMentionCandidates(bridgeState);

  assert.deepEqual(
    candidates.map((candidate) => `${candidate.targetKind}:${candidate.displayLabel}`),
    ['bridge-person:Alice', "bridge-agent:Alice's Kordi"],
  );
  assert.equal(candidates.some((candidate) => candidate.displayLabel === 'kd_remote_node_123'), false);
});

test('buildBridgeMentionCandidates falls back to node id when no friendly labels exist', () => {
  const bridgeState = bridgeStateWithPeers([
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

  const candidates = buildBridgeMentionCandidates(bridgeState);

  assert.deepEqual(
    candidates.map((candidate) => `${candidate.targetKind}:${candidate.displayLabel}`),
    ['bridge-agent:kd_unlabeled_node_123'],
  );
});

test('resolveMentionedBridgeTarget uses the same unique handle as autocomplete candidates', () => {
  const bridgeState = bridgeStateWithPeers([
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

  const target = resolveMentionedBridgeTarget('@AnnLeehumanbet please review', bridgeState);

  assert.equal(target?.peer.nodeId, 'node-beta-333');
  assert.equal(target?.label, 'AnnLeehumanbet');
  assert.equal(target?.displayLabel, 'Ann-Lee');
  assert.equal(target?.requestText, 'please review');
});

test('outreach identity preserves display label while mention metadata stores safe handle', () => {
  const bridgeState = bridgeStateWithPeers([
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

  const target = resolveMentionedBridgeTarget('@AlicesKordi summarize this', bridgeState);
  assert.ok(target);
  assert.equal(target.label, 'AlicesKordi');
  assert.equal(target.displayLabel, "Alice's Kordi");
  assert.equal(outreachIdentityForBridgeTarget(target).targetDisplayName, "Alice's Kordi");
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
    resolveMentionedBridgeTarget("@Alice's Kordi summarize", unambiguousState)?.peer.nodeId,
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

  assert.equal(resolveMentionedBridgeTarget("@Alice's Kordi summarize", ambiguousState), null);
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
    ['Kordi', 'OwnersKordi', 'HostOne', 'MyKordi', 'MyOwnersKordi', 'HostOwnersKordi', 'HostOwnersOwnersKordi', 'agentlocal', 'localnode1', 'MyProject'],
  );
});

test('outreach self target metadata for @Agent prefers canonical agent identity', () => {
  const bridgeState = bridgeStateWithPeers([
    peer({
      nodeId: 'node-alice-1',
      displayName: "Alice's Kordi",
      ownerName: 'Alice',
      runtime: 'kordi-local',
      humanId: 'human-alice',
      agentId: 'agent-alice',
    }),
  ]);
  const conversation = groupConversationWithHumans([{ id: 'human:alice', name: 'Alice', humanId: 'human-alice', bridgeNodeId: 'node-alice-1' }]);
  conversation.canonicalParticipants?.push({
    id: 'agent:alice-kordi',
    name: "Alice's Kordi",
    kind: 'agent',
    role: 'delegate',
    source: 'bridge',
    ownerIdentityId: 'human:alice',
    ownerName: 'Alice',
    bridgeNodeId: 'node-alice-1',
    humanId: 'human-alice',
    agentId: 'agent-alice',
  });

  const target = resolveMentionedBridgeTarget('@AlicesKordi summarize this', bridgeState, conversation, { targetKind: 'bridge-agent' });

  assert.ok(target);
  assert.deepEqual(selfTargetIdentityForMentionedBridgeTarget(target, conversation), {
    identityId: 'agent:alice-kordi',
    displayName: "Alice's Kordi",
    kind: 'agent',
    ownerIdentityId: 'human:alice',
    ownerDisplayName: 'Alice',
    bridgeNodeId: 'node-alice-1',
    humanId: 'human-alice',
    agentId: 'agent-alice',
  });
});

test('project outreach self target metadata falls back to mention target when no canonical participants exist', () => {
  const bridgeState = bridgeStateWithPeers([
    peer({
      nodeId: 'node-carol-1',
      displayName: "Carol's Kordi",
      ownerName: 'Carol',
      runtime: 'kordi-remote',
      humanId: 'human-carol',
      agentId: 'agent-carol',
    }),
  ]);

  const target = resolveMentionedBridgeTarget('@CarolsKordi check the project', bridgeState, null, { targetKind: 'bridge-agent' });

  assert.ok(target);
  assert.deepEqual(selfTargetIdentityForMentionedBridgeTarget(target, null), {
    identityId: null,
    displayName: "Carol's Kordi",
    kind: 'agent',
    ownerDisplayName: 'Carol',
    bridgeNodeId: 'node-carol-1',
    humanId: 'human-carol',
    agentId: 'agent-carol',
    runtime: 'kordi-remote',
  });
});

test('outreach metadata for @Person includes canonical initiator and human target identities', () => {
  const bridgeState = bridgeStateWithPeers([
    peer({
      nodeId: 'node-bob-1',
      displayName: "Bob's Kordi",
      ownerName: 'Bob',
      runtime: 'kordi-local',
      humanId: 'human-bob',
      agentId: 'agent-bob',
    }),
  ]);
  const conversation = directPersonConversationWithHuman({
    id: 'human:bob',
    name: 'Bob',
    humanId: 'human-bob',
    bridgeNodeId: 'node-bob-1',
  });

  const target = resolveMentionedBridgeTarget('@Bob please review', bridgeState, conversation, { targetKind: 'bridge-person' });

  assert.ok(target);
  assert.deepEqual(initiatorIdentityForOutreach(conversation, 'human:host'), {
    identityId: 'human:host',
    displayName: 'Host Owner',
    kind: 'human',
    bridgeNodeId: 'host-node-1',
    humanId: 'host-human-1',
  });
  assert.deepEqual(selfTargetIdentityForMentionedBridgeTarget(target, conversation), {
    identityId: 'human:bob',
    displayName: 'Bob',
    kind: 'human',
    bridgeNodeId: 'node-bob-1',
    humanId: 'human-bob',
  });
});
