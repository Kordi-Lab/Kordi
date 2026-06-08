import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  chatCompanionCandidates,
  chatCompanionSideForPaneKinds,
  chatCompanionSideFromDropPosition,
  chatCopilotConversationForOpenRequest,
  cloudSelfAgentSyncStatusLabel,
  humanSideFromCompanionDrop,
  pairedCompanionConversation,
  parseChatCopilotTriggerCommand,
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

test('chat headers do not render My agent or chat-kind label pills', () => {
  const source = readFileSync(new URL('../src/pages/ChatsPage.tsx', import.meta.url), 'utf8');

  assert.doesNotMatch(source, /<TypeBadge/);
  assert.doesNotMatch(source, /shouldShowConversationTypeBadge\(/);
  assert.doesNotMatch(source, />\s*\{companionLabel\(companionConversation\)\}\s*<\/span>/);
});

test('chat header title text does not flex-grow away from fork or action pills', () => {
  const source = readFileSync(new URL('../src/pages/ChatsPage.tsx', import.meta.url), 'utf8');

  assert.doesNotMatch(source, /min-w-\[12rem\] max-w-full flex-1 break-words/);
  assert.doesNotMatch(source, /min-w-\[10rem\] flex-1 break-words/);
});

test('chat header cloud self-agent sync indicator is icon-only', () => {
  const source = readFileSync(new URL('../src/pages/ChatsPage.tsx', import.meta.url), 'utf8');
  const indicatorStart = source.indexOf('data-cloud-self-agent-sync-status');
  const indicatorMarkup = source.slice(indicatorStart, source.indexOf('{activeForkSourceSessionId', indicatorStart));

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

test('chat co-pilot does not auto-open from candidates without an explicit request', () => {
  const agentChat = conversation({ id: 'agent-chat', type: 'owned-agent' });

  assert.equal(chatCopilotConversationForOpenRequest(null, [agentChat]), null);
  assert.equal(chatCopilotConversationForOpenRequest('agent-chat', [agentChat])?.id, 'agent-chat');
  assert.equal(chatCopilotConversationForOpenRequest('missing-chat', [agentChat]), null);
});

test('chat co-pilot slash commands parse private prompt text', () => {
  assert.deepEqual(parseChatCopilotTriggerCommand('/copilot draft a reply'), { prompt: 'draft a reply' });
  assert.deepEqual(parseChatCopilotTriggerCommand('/ask summarize this thread'), { prompt: 'summarize this thread' });
  assert.deepEqual(parseChatCopilotTriggerCommand('  /copilot   '), { prompt: '' });
  assert.equal(parseChatCopilotTriggerCommand('/reply draft a reply'), null);
  assert.equal(parseChatCopilotTriggerCommand('please /ask later'), null);
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

test('chat co-pilot opens from an explicit header action with private scope copy', () => {
  const source = readFileSync(new URL('../src/pages/ChatsPage.tsx', import.meta.url), 'utf8');

  assert.match(source, /Ask co-pilot/);
  assert.match(source, /data-chat-copilot-scope="private"/);
  assert.match(source, /Private helper for this chat/);
  assert.doesNotMatch(source, /const companionConversation =[^;]+\?\? suggestedCompanionConversation/s);
});

test('chat co-pilot slash trigger opens the rail instead of sending slash text to main chat', () => {
  const source = readFileSync(new URL('../src/pages/ChatsPage.tsx', import.meta.url), 'utf8');

  assert.match(source, /const handleSendChatMessage = \(draftOverride\?: string\) =>/);
  assert.match(source, /parseChatCopilotTriggerCommand\(draft\)/);
  assert.match(source, /openCopilotRail\(trigger\.prompt\)/);
  assert.match(source, /onSendChatMessage\(draftOverride\)/);
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
  assert.match(source, /companionPaneKind === 'agent' \? 'Ask privately…'/);
  assert.match(source, /companionShowsLocalAgentControls/);
  assert.match(source, /companionPaneKind === 'agent' && !companionConversationHasBridgeTransport/);
});
