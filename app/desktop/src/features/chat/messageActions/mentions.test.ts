import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildBridgeMentionCandidates,
  localAgentMentionLabels,
  mentionHandleForLabel,
  outreachIdentityForBridgeTarget,
  resolveMentionedBridgeTarget,
} from './mentions';
import type { DesktopBridgeState, DesktopChatState } from '@/kordi-app/types';

function bridgeStateWithPeers(peers: DesktopBridgeState['hosts'][number]['visiblePeers']): DesktopBridgeState {
  return {
    activeHostId: 'host-1',
    hosts: [{
      id: 'host-1',
      displayName: 'Host One',
      ownerName: 'Host Owner',
      nodeId: 'host-node-1',
      humanId: 'host-human-1',
      inviteCode: null,
      inviteExpiresAt: null,
      configPath: null,
      activeAgentId: 'agent-local',
      agents: [{
        id: 'agent-local',
        nodeId: 'local-node-1',
        label: "Owner's Kordi",
        runtime: 'kordi-local',
        isDefault: true,
        isActive: true,
      }],
      visiblePeers: peers,
      conversations: [],
    }],
    activeConversationId: null,
    activeConversation: null,
    settings: {
      displayName: 'Host Owner',
      enableMdns: true,
      enableDerp: true,
      allowLanDiscovery: true,
      allowRelayFallback: true,
    },
  } as DesktopBridgeState;
}

test('mentionHandleForLabel keeps only unicode letters and numbers', () => {
  assert.equal(mentionHandleForLabel("Alice's Kordi"), 'AlicesKordi');
  assert.equal(mentionHandleForLabel('Ann Lee'), 'AnnLee');
  assert.equal(mentionHandleForLabel('開発 チーム 42'), '開発チーム42');
  assert.equal(mentionHandleForLabel('!!!', 'node-123'), 'node123');
});

test('buildBridgeMentionCandidates creates unique stable handles for sanitized collisions', () => {
  const bridgeState = bridgeStateWithPeers([
    {
      nodeId: 'node-alpha-111',
      displayName: 'Ann Lee',
      ownerName: 'Ann Lee',
      runtime: 'person',
      humanId: 'human-alpha-222',
      agentId: null,
      isDefaultAgent: false,
    },
    {
      nodeId: 'node-beta-333',
      displayName: 'Ann-Lee',
      ownerName: 'Ann-Lee',
      runtime: 'person',
      humanId: 'human-beta-444',
      agentId: null,
      isDefaultAgent: false,
    },
  ]);

  const annCandidates = buildBridgeMentionCandidates(bridgeState)
    .filter((candidate) => candidate.targetKind === 'bridge-person' && candidate.displayLabel.startsWith('Ann'));

  assert.equal(annCandidates.length, 2);
  assert.deepEqual(
    annCandidates.map((candidate) => candidate.handle).sort(),
    ['AnnLeehumanalp', 'AnnLeehumanbet'].sort(),
  );
});

test('resolveMentionedBridgeTarget uses the same unique handle as autocomplete candidates', () => {
  const bridgeState = bridgeStateWithPeers([
    {
      nodeId: 'node-alpha-111',
      displayName: 'Ann Lee',
      ownerName: 'Ann Lee',
      runtime: 'person',
      humanId: 'human-alpha-222',
      agentId: null,
      isDefaultAgent: false,
    },
    {
      nodeId: 'node-beta-333',
      displayName: 'Ann-Lee',
      ownerName: 'Ann-Lee',
      runtime: 'person',
      humanId: 'human-beta-444',
      agentId: null,
      isDefaultAgent: false,
    },
  ]);

  const target = resolveMentionedBridgeTarget('@AnnLeehumanbet please review', bridgeState);

  assert.equal(target?.peer.nodeId, 'node-beta-333');
  assert.equal(target?.label, 'AnnLeehumanbet');
  assert.equal(target?.displayLabel, 'Ann-Lee');
  assert.equal(target?.requestText, 'please review');
});

test('outreach identity preserves display label while mention metadata stores safe handle', () => {
  const bridgeState = bridgeStateWithPeers([
    {
      nodeId: 'node-kordi-1',
      displayName: "Alice's Kordi",
      ownerName: 'Alice',
      runtime: 'kordi-local',
      humanId: 'human-alice',
      agentId: 'agent-alice',
      isDefaultAgent: true,
    },
  ]);

  const target = resolveMentionedBridgeTarget('@AlicesKordi summarize this', bridgeState);
  assert.ok(target);
  assert.equal(target.label, 'AlicesKordi');
  assert.equal(target.displayLabel, "Alice's Kordi");
  assert.equal(outreachIdentityForBridgeTarget(target).targetDisplayName, "Alice's Kordi");
});

test('legacy display-label matching works only when unambiguous', () => {
  const unambiguousState = bridgeStateWithPeers([
    {
      nodeId: 'node-alice-1',
      displayName: "Alice's Kordi",
      ownerName: 'Alice',
      runtime: 'kordi-local',
      humanId: 'human-alice',
      agentId: 'agent-alice',
      isDefaultAgent: true,
    },
  ]);

  assert.equal(
    resolveMentionedBridgeTarget("@Alice's Kordi summarize", unambiguousState)?.peer.nodeId,
    'node-alice-1',
  );

  const ambiguousState = bridgeStateWithPeers([
    {
      nodeId: 'node-a-1',
      displayName: "Alice's Kordi",
      ownerName: 'Alice',
      runtime: 'kordi-local',
      humanId: 'human-a',
      agentId: 'agent-a',
      isDefaultAgent: true,
    },
    {
      nodeId: 'node-a-2',
      displayName: "Alice's Kordi",
      ownerName: 'Alice',
      runtime: 'kordi-local',
      humanId: 'human-b',
      agentId: 'agent-b',
      isDefaultAgent: true,
    },
  ]);

  assert.equal(resolveMentionedBridgeTarget("@Alice's Kordi summarize", ambiguousState), null);
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
    ['Kordi', 'OwnersKordi', 'HostOne', 'HostOwnersKordi', 'agentlocal', 'localnode1', 'MyProject'],
  );
});
