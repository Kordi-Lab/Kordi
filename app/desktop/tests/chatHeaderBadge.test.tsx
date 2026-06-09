import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  chatCompanionCandidates,
  chatCompanionSideForPaneKinds,
  chatCompanionSideFromDropPosition,
  buildAskAgentSessionReferenceContext,
  chatSideAgentConversationForOpenRequest,
  cloudSelfAgentSyncStatusLabel,
  humanSideFromCompanionDrop,
  pairedCompanionConversation,
  parseAskAgentTriggerCommand,
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

test('side agent panel does not auto-open from candidates without an explicit request', () => {
  const agentChat = conversation({ id: 'agent-chat', type: 'owned-agent' });

  assert.equal(chatSideAgentConversationForOpenRequest(null, [agentChat]), null);
  assert.equal(chatSideAgentConversationForOpenRequest('agent-chat', [agentChat])?.id, 'agent-chat');
  assert.equal(chatSideAgentConversationForOpenRequest('missing-chat', [agentChat]), null);
});

test('ask agent slash commands parse prompt text without co-pilot aliases', () => {
  assert.deepEqual(parseAskAgentTriggerCommand('/ask summarize this thread'), { prompt: 'summarize this thread' });
  assert.deepEqual(parseAskAgentTriggerCommand('  /ask   '), { prompt: '' });
  assert.equal(parseAskAgentTriggerCommand('/copilot draft a reply'), null);
  assert.equal(parseAskAgentTriggerCommand('/reply draft a reply'), null);
  assert.equal(parseAskAgentTriggerCommand('please /ask later'), null);
});

test('ask agent candidates include only agent sessions from any current chat', () => {
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
    ['second-agent'],
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

test('ask agent candidates exclude canonical group chats even with agent-ish type', () => {
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
    [],
  );
});

test('chat companion split controls live on the divider instead of floating over headers', () => {
  const source = readFileSync(new URL('../src/pages/ChatsPage.tsx', import.meta.url), 'utf8');

  assert.match(source, /data-split-layout-divider="true"/);
  assert.doesNotMatch(source, /data-split-layout-toolbar/);
  assert.doesNotMatch(source, /setIsCompanionFolded\(true\)/);
});

test('ask agent opens an explicit side session with neutral copy and reference chip', () => {
  const source = readFileSync(new URL('../src/pages/ChatsPage.tsx', import.meta.url), 'utf8');

  assert.match(source, /Ask Agent/);
  assert.match(source, /data-chat-side-agent-panel="true"/);
  assert.match(source, /Reference: Current chat/);
  assert.match(source, /Agent session/);
  assert.match(source, /New session/);
  assert.doesNotMatch(source, /Ask co-pilot|Co-pilot|Private helper|Ask privately|data-chat-copilot-scope/);
  assert.doesNotMatch(source, /const companionConversation =[^;]+\?\? suggestedCompanionConversation/s);
});

test('ask agent slash trigger opens the side session instead of sending slash text to main chat', () => {
  const source = readFileSync(new URL('../src/pages/ChatsPage.tsx', import.meta.url), 'utf8');

  assert.match(source, /const handleSendChatMessage = \(draftOverride\?: string\) =>/);
  assert.match(source, /parseAskAgentTriggerCommand\(draft\)/);
  assert.match(source, /openSideAgentPanel\(trigger\.prompt\)/);
  assert.match(source, /onSendChatMessage\(draftOverride\)/);
});

test('ask agent new session action switches the side panel to the created agent session', () => {
  const source = readFileSync(new URL('../src/pages/ChatsPage.tsx', import.meta.url), 'utf8');

  assert.match(source, /const createdConversationId = await onCreateAgentSession\(\)/);
  assert.match(source, /setOpenSideAgentConversationId\(createdConversationId\)/);
  assert.match(source, /setSelectedCompanionConversationId\(createdConversationId\)/);
});

test('chat companion pane does not expose focus handoff controls', () => {
  const source = readFileSync(new URL('../src/pages/ChatsPage.tsx', import.meta.url), 'utf8');

  assert.doesNotMatch(source, /openCompanionDraft/);
  assert.doesNotMatch(source, /Focus \$\{companionConversation\.name\}/);
  assert.doesNotMatch(source, /to send this draft/);
});

test('chat companion composer sends with Enter and keeps modified Enter for line breaks', () => {
  const source = readFileSync(new URL('../src/pages/ChatsPage.tsx', import.meta.url), 'utf8');

  assert.match(source, /onSendChatMessage\(prompt, conversation\.id\)/);
  assert.match(source, /event\.key === 'Enter' && !event\.metaKey && !event\.ctrlKey && !event\.shiftKey/);
  assert.match(source, /title=\{`Send to \$\{companionConversation\.name\}`\}/);
});

test('human panes do not show agent model controls while agent side panes use agent placeholder', () => {
  const source = readFileSync(new URL('../src/pages/ChatsPage.tsx', import.meta.url), 'utf8');

  assert.match(source, /activePaneKind === 'agent' && !activeConversationIsBridge/);
  assert.match(source, /companionPaneKind === 'agent' \? 'Ask the agent…'/);
  assert.match(source, /companionShowsLocalAgentControls/);
  assert.match(source, /companionPaneKind === 'agent' && !companionConversationHasBridgeTransport/);
});

test('ask agent reference context includes session metadata and recent messages only', () => {
  const context = buildAskAgentSessionReferenceContext(conversation({
    id: 'session:group:launch',
    name: 'Launch chat',
    canonicalSessionId: 'session:group:launch',
    directness: 'Group chat',
    messages: [
      { id: 'old', role: 'person', sender: 'Alice', text: 'old hidden message' },
      { id: 'm1', role: 'person', sender: 'Tom', text: 'canary is ready' },
      { id: 'm2', role: 'user', sender: 'Me', text: 'please review rollout' },
      { id: 'm3', role: 'person', sender: 'Tom', text: 'rollout looks fine' },
      { id: 'm4', role: 'assistant', sender: 'Kordi', text: 'summary prepared' },
    ] as Conversation['messages'],
  }), 4);

  assert.match(context, /Reference: Current chat/);
  assert.match(context, /Session: Launch chat/);
  assert.match(context, /Session id: session:group:launch/);
  assert.match(context, /Type: Group chat/);
  assert.match(context, /Recent messages:/);
  assert.doesNotMatch(context, /old hidden message/);
  assert.match(context, /Tom: canary is ready/);
  assert.match(context, /Me: please review rollout/);
});
