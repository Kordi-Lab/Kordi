import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bridgeMentionCandidateOptionText,
  buildBridgeMentionCandidates,
  localAgentMentionLabels,
  mentionHandleForLabel,
  outreachIdentityForBridgeTarget,
  publicLocalAgentMentionText,
  resolveMentionedBridgeTarget,
} from '../src/features/chat/messageActions/mentions';
import type { DesktopBridgePeer, DesktopBridgeState, DesktopChatState } from '../src/kordi-app/types';

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
