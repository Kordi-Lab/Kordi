import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  chatCompanionCandidates,
  chatCompanionSideForPaneKinds,
  chatCompanionSideFromDropPosition,
  cloudSelfAgentSyncStatusLabel,
  humanSideFromCompanionDrop,
  pairedCompanionConversation,
  shouldShowConversationTypeBadge,
} from '../src/pages/ChatsPage';
import type { Conversation } from '../src/kordi-app/types';

function conversation(overrides: Partial<Conversation>): Conversation {
  return {
    id: 'conversation',
    name: 'Conversation',
    type: 'person',
    subtitle: '',
    unread: 0,
    bridges: [],
    trust: 'Trusted',
    directness: 'Direct',
    participants: [],
    messages: [],
    ...overrides,
  };
}

test('chat header hides the My agent badge for canonical group sessions', () => {
  assert.equal(shouldShowConversationTypeBadge({
    id: 'session:group:342f31b1-534d-4f3b-b4bd-855072767854',
    canonicalSessionId: 'session:group:342f31b1-534d-4f3b-b4bd-855072767854',
    type: 'owned-agent',
  }), false);
});

test('chat header hides the My agent badge for forks of canonical group sessions', () => {
  assert.equal(shouldShowConversationTypeBadge({
    id: 'session:fork:606437914b634d4490e509a7916fbb72',
    canonicalSessionId: 'session:fork:606437914b634d4490e509a7916fbb72',
    type: 'owned-agent',
    forkedFromSessionId: 'session:group:c0865259-a991-48bf-9752-56daf674e4f9',
  }), false);
});

test('chat header keeps the My agent badge for true self-agent sessions', () => {
  assert.equal(shouldShowConversationTypeBadge({
    id: '4367e286-afb4-4941-b0cb-7d644b0f6ce6',
    canonicalSessionId: '4367e286-afb4-4941-b0cb-7d644b0f6ce6',
    type: 'owned-agent',
  }), true);
});

test('chat header cloud self-agent sync indicator is icon-only', () => {
  const source = readFileSync(new URL('../src/pages/ChatsPage.tsx', import.meta.url), 'utf8');
  const indicatorStart = source.indexOf('data-cloud-self-agent-sync-status');
  const indicatorMarkup = source.slice(indicatorStart, source.indexOf('{shouldShowConversationTypeBadge', indicatorStart));

  assert.match(indicatorMarkup, /<Cloud/);
  assert.doesNotMatch(indicatorMarkup, /\{activeCloudSelfAgentSyncLabel\}/);
});

test('chat header cloud self-agent sync label is concise and stable', () => {
  assert.equal(cloudSelfAgentSyncStatusLabel(undefined), null);
  assert.equal(cloudSelfAgentSyncStatusLabel({ state: 'syncing', pendingCount: 2 }), 'Syncing 2');
  assert.equal(cloudSelfAgentSyncStatusLabel({ state: 'synced' }), 'Synced');
  assert.equal(cloudSelfAgentSyncStatusLabel({ state: 'error', message: 'network failed' }), 'Sync issue');
});

test('chat companion pairing links human chats to that human owner agent chat', () => {
  const humanChat = conversation({
    id: 'human-chat',
    name: 'Jiaxin',
    type: 'person',
    bridgeTarget: {
      hostId: 'cloud',
      nodeId: 'acct_jiaxin',
      displayName: 'Jiaxin',
      ownerName: 'Jiaxin',
      runtime: 'person',
      humanId: 'acct_jiaxin',
    },
    canonicalParticipants: [{
      id: 'human:acct_jiaxin',
      name: 'Jiaxin',
      kind: 'human',
      role: 'participant',
      source: 'bridge',
      bridgeHostId: 'cloud',
      bridgeNodeId: 'acct_jiaxin',
      humanId: 'acct_jiaxin',
    }],
  });
  const ownerAgentChat = conversation({
    id: 'agent-chat',
    name: 'Jiaxin Agent',
    type: 'external-agent',
    bridgeTarget: {
      hostId: 'cloud',
      nodeId: 'agent_jiaxin',
      displayName: 'Jiaxin Agent',
      ownerName: 'Jiaxin',
      runtime: 'agent',
      agentId: 'agent_jiaxin',
    },
    canonicalParticipants: [{
      id: 'agent:jiaxin',
      name: 'Jiaxin Agent',
      kind: 'agent',
      role: 'delegate',
      source: 'bridge',
      ownerIdentityId: 'human:acct_jiaxin',
      ownerName: 'Jiaxin',
      bridgeHostId: 'cloud',
      bridgeNodeId: 'agent_jiaxin',
      agentId: 'agent_jiaxin',
    }],
  });

  assert.equal(pairedCompanionConversation(humanChat, [humanChat, ownerAgentChat])?.id, 'agent-chat');
  assert.equal(pairedCompanionConversation(ownerAgentChat, [humanChat, ownerAgentChat])?.id, 'human-chat');
});

test('chat companion candidates include any opposite-kind chat, not just related chats', () => {
  const humanChat = conversation({ id: 'human-chat', type: 'person' });
  const firstAgentChat = conversation({ id: 'first-agent', type: 'owned-agent' });
  const secondAgentChat = conversation({
    id: 'second-agent',
    type: 'external-agent',
    bridgeTarget: {
      hostId: 'cloud',
      nodeId: 'agent_unrelated',
      displayName: 'Unrelated Agent',
      ownerName: 'Different Person',
      runtime: 'agent',
      agentId: 'agent_unrelated',
    },
  });
  const otherHumanChat = conversation({ id: 'other-human', type: 'person' });

  assert.deepEqual(
    chatCompanionCandidates(humanChat, [humanChat, firstAgentChat, secondAgentChat, otherHumanChat]).map((candidate) => candidate.id),
    ['first-agent', 'second-agent'],
  );
  assert.deepEqual(
    chatCompanionCandidates(firstAgentChat, [humanChat, firstAgentChat, secondAgentChat, otherHumanChat]).map((candidate) => candidate.id),
    ['human-chat', 'other-human'],
  );
});

test('chat companion drag drop chooses the target side from the drop half', () => {
  assert.equal(chatCompanionSideFromDropPosition(149, 100, 100), 'left');
  assert.equal(chatCompanionSideFromDropPosition(150, 100, 100), 'right');
});

test('chat companion side keeps human and agent absolute positions stable', () => {
  assert.equal(chatCompanionSideForPaneKinds('human', 'left'), 'right');
  assert.equal(chatCompanionSideForPaneKinds('agent', 'left'), 'left');
  assert.equal(chatCompanionSideForPaneKinds('human', 'right'), 'left');
  assert.equal(chatCompanionSideForPaneKinds('agent', 'right'), 'right');
  assert.equal(humanSideFromCompanionDrop('human', 'left'), 'left');
  assert.equal(humanSideFromCompanionDrop('agent', 'left'), 'right');
});

test('chat companion candidates treat owned-agent chats with human participants as agents', () => {
  const humanChat = conversation({ id: 'human-chat', type: 'person' });
  const ownedAgentGroupChat = conversation({
    id: 'agent-group-chat',
    type: 'owned-agent',
    canonicalParticipants: [{
      id: 'human:acct_shu',
      name: 'Shu Yang',
      kind: 'human',
      role: 'participant',
      source: 'bridge',
      bridgeHostId: 'cloud',
      bridgeNodeId: 'acct_shu',
      humanId: 'acct_shu',
    }],
  });

  assert.deepEqual(
    chatCompanionCandidates(humanChat, [humanChat, ownedAgentGroupChat]).map((candidate) => candidate.id),
    ['agent-group-chat'],
  );
  assert.equal(chatCompanionSideForPaneKinds('agent', 'left'), 'left');
});

test('chat companion candidates keep canonical group chats in the human pane even with agent-ish type', () => {
  const groupChat = conversation({
    id: 'group-chat',
    canonicalSessionId: 'session:group:abc',
    participantSpaceId: 'group:abc',
    directness: 'Group chat',
    type: 'owned-agent',
  });
  const agentChat = conversation({ id: 'agent-chat', type: 'owned-agent' });
  const humanChat = conversation({ id: 'human-chat', type: 'person' });

  assert.deepEqual(
    chatCompanionCandidates(groupChat, [groupChat, agentChat, humanChat]).map((candidate) => candidate.id),
    ['agent-chat'],
  );
  assert.deepEqual(
    chatCompanionCandidates(agentChat, [groupChat, agentChat, humanChat]).map((candidate) => candidate.id),
    ['group-chat', 'human-chat'],
  );
});

test('chat companion split controls live on the divider instead of floating over headers', () => {
  const source = readFileSync(new URL('../src/pages/ChatsPage.tsx', import.meta.url), 'utf8');

  assert.match(source, /data-split-layout-divider="true"/);
  assert.doesNotMatch(source, /data-split-layout-toolbar/);
});

test('chat companion pane does not expose focus handoff controls', () => {
  const source = readFileSync(new URL('../src/pages/ChatsPage.tsx', import.meta.url), 'utf8');

  assert.doesNotMatch(source, /openCompanionDraft/);
  assert.doesNotMatch(source, /Focus \$\{companionConversation\.name\}/);
  assert.doesNotMatch(source, /to send this draft/);
});

test('chat companion composer sends with Enter and keeps modified Enter for line breaks', () => {
  const source = readFileSync(new URL('../src/pages/ChatsPage.tsx', import.meta.url), 'utf8');

  assert.match(source, /onSendChatMessage\(draft, conversation\.id\)/);
  assert.match(source, /event\.key === 'Enter' && !event\.metaKey && !event\.ctrlKey && !event\.shiftKey/);
  assert.match(source, /title=\{`Send to \$\{companionConversation\.name\}`\}/);
});

test('human panes do not show agent model controls while agent side panes use agent placeholder', () => {
  const source = readFileSync(new URL('../src/pages/ChatsPage.tsx', import.meta.url), 'utf8');

  assert.match(source, /activePaneKind === 'agent' && !activeConversationIsBridge/);
  assert.match(source, /companionPaneKind === 'agent' \? chatComposerPlaceholder\(companionConversation\)/);
  assert.match(source, /companionShowsLocalAgentControls/);
  assert.match(source, /companionPaneKind === 'agent' && !companionConversationHasBridgeTransport/);
});
