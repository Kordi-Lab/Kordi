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
  humanSideForCompanionSide,
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

test('compact transcript density applies to human and agent sessions', () => {
  const source = readFileSync(new URL('../src/pages/ChatsPage.tsx', import.meta.url), 'utf8');

  assert.match(source, /function chatTranscriptDensityMode\(conversation: Conversation\)/);
  assert.match(source, /conversationUsesCompactHumanTranscriptDensity\(conversation\)/);
  assert.match(source, /densityMode=\{chatTranscriptDensityMode\(activeConv\)\}/);
  assert.match(source, /densityMode=\{chatTranscriptDensityMode\(companionConversation\)\}/);
  assert.match(source, /if \(conversationIsAgentChat\(conversation\)\) return 'agent-compact';/);
  assert.match(source, /if \(conversationIsGroupChat\(conversation\)\) return 'group-compact';/);
  assert.match(source, /return 'contact-compact'/);
  assert.match(source, /return 'default'/);
});

test('chat header title text does not flex-grow away from fork or action pills', () => {
  const source = readFileSync(new URL('../src/pages/ChatsPage.tsx', import.meta.url), 'utf8');

  assert.doesNotMatch(source, /min-w-\[12rem\] max-w-full flex-1 break-words/);
  assert.doesNotMatch(source, /min-w-\[10rem\] flex-1 break-words/);
});

test('chat headers use compact inline subtitle tags instead of tall stacked subtitles', () => {
  const source = readFileSync(new URL('../src/pages/ChatsPage.tsx', import.meta.url), 'utf8');

  assert.doesNotMatch(source, /min-h-\[112px\]/);
  assert.match(source, /min-h-\[72px\]/);
  assert.match(source, /data-chat-session-subtitle-pill="true"/);
  assert.doesNotMatch(source, /mt-0\.5 flex min-w-0 items-center text-\[11px\] leading-5 text-slate-400/);
  assert.doesNotMatch(source, /mt-0\.5 text-\[11px\] leading-5 text-slate-400">Agent session/);
});

test('chat and project header utility buttons follow flat chip styling without standout overrides', () => {
  const chatSource = readFileSync(new URL('../src/pages/ChatsPage.tsx', import.meta.url), 'utf8');
  const projectSource = readFileSync(new URL('../src/pages/ProjectsPage.tsx', import.meta.url), 'utf8');
  const askAgentButton = chatSource.slice(chatSource.indexOf('aria-label="Ask Agent"') - 360, chatSource.indexOf('aria-label="Ask Agent"') + 180);
  const mainChatDetailButtonStart = chatSource.indexOf('className="app-utility-button', chatSource.indexOf('aria-label="Ask Agent"'));
  const chatDetailsButton = chatSource.slice(mainChatDetailButtonStart - 120, mainChatDetailButtonStart + 320);
  const projectDetailsButton = projectSource.slice(projectSource.indexOf('aria-label={isDetailPanelCollapsed') - 260, projectSource.indexOf('aria-label={isDetailPanelCollapsed') + 180);

  assert.doesNotMatch(`${askAgentButton}\n${chatDetailsButton}\n${projectDetailsButton}`, /border-pink|bg-white\/\[0\.06\]|text-pink|text-slate-100/);
  assert.match(askAgentButton, /className="app-utility-button[^"]*font-medium transition"/);
  assert.match(chatDetailsButton, /className="app-utility-button[^"]*font-medium transition"/);
  assert.match(projectDetailsButton, /className="app-utility-button[^"]*font-medium transition"/);
});

test('message selection control is smaller than the old oversized blue circle', () => {
  const source = readFileSync(new URL('../src/kordi-app/components/transcript.tsx', import.meta.url), 'utf8');

  assert.doesNotMatch(source, /app-message-selection-control grid h-6\.5 w-6\.5/);
  assert.match(source, /app-message-selection-control grid h-5\.5 w-5\.5/);
  assert.match(source, /<Check className="h-3 w-3"/);
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

test('ask agent side defaults to the right for both human and agent main sessions', () => {
  assert.equal(chatCompanionSideForPaneKinds('human', 'left'), 'right');
  assert.equal(chatCompanionSideForPaneKinds('agent', 'right'), 'right');
  assert.equal(humanSideForCompanionSide('human', 'right'), 'left');
  assert.equal(humanSideForCompanionSide('agent', 'right'), 'right');
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
  assert.match(source, /data-split-layout-grip="true"/);
  assert.doesNotMatch(source, /app-chat-split-divider[^"`]*border-x/);
  assert.doesNotMatch(source, /rounded-full border border-white\/\[0\.08\] bg-black\/20 p-1/);
  assert.doesNotMatch(source, /shadow-\[0_12px_28px_rgba\(0,0,0,0\.22\)\]/);
  assert.doesNotMatch(source, /app-chat-companion-pane[^"`]*data-\[side=right\]:border-l/);
  assert.doesNotMatch(source, /app-chat-companion-pane[^"`]*data-\[side=left\]:border-r/);
  assert.doesNotMatch(source, /data-split-layout-toolbar/);
  assert.doesNotMatch(source, /setIsCompanionFolded\(true\)/);
  assert.doesNotMatch(source, /<ArrowRightLeft/);
  assert.doesNotMatch(source, /moveCompanionToSide\(/);
});

test('ask agent opens an explicit side session with neutral copy and clean header', () => {
  const source = readFileSync(new URL('../src/pages/ChatsPage.tsx', import.meta.url), 'utf8');
  const sidePanelStart = source.indexOf('data-chat-side-agent-panel="true"');
  const sidePanelHeader = source.slice(sidePanelStart, source.indexOf('<ChatSessionPane', sidePanelStart));

  assert.doesNotMatch(sidePanelHeader, /<GripVertical/);
  assert.match(source, /Ask Agent/);
  assert.match(source, /data-chat-side-agent-panel="true"/);
  assert.doesNotMatch(sidePanelHeader, /Reference: Current chat/);
  assert.doesNotMatch(sidePanelHeader, /sideAgentReferenceContext/);
  assert.match(source, /Agent session/);
  assert.match(source, /aria-label="Side chat options"/);
  assert.match(source, /aria-label="Close side chat"/);
  assert.match(sidePanelHeader, /data-side-chat-controls="true"/);
  assert.doesNotMatch(sidePanelHeader, /rounded-full border border-white\/10 bg-white\/\[0\.035\] p-1 shadow/);
  assert.doesNotMatch(sidePanelHeader, /app-icon-button app-utility-button h-7 w-7 rounded-full p-0 text-slate-100/);
  assert.match(sidePanelHeader, /hover:bg-\[color:var\(--app-control-hover\)\]/);
  assert.match(source, /data-side-chat-root-menu="true"/);
  assert.match(source, /app-page-header[^"`]*z-40/);
  assert.match(source, /data-side-chat-options-menu="true"/);
  assert.match(source, /z-50/);
  assert.match(source, /data-chat-inline-detail-rail="true"/);
  assert.match(source, /ownInlineDetailRail\s*=\s*showRightDetailRail\s*&&\s*!isDetailPanelCollapsed/);
  assert.match(source, /data-companion-composer-footer="true"/);
  assert.match(source, /data-companion-send-row="true"/);
  assert.match(source, /data-companion-send-control="true"/);
  assert.match(source, /data-companion-model-controls="true"/);
  assert.doesNotMatch(source, /data-companion-detail-toggle/);
  assert.doesNotMatch(source, /data-chat-side-detail-rail/);
  assert.doesNotMatch(source, /setIsCompanionDetailOpen/);
  assert.doesNotMatch(source, /CHAT_SIDE_DETAIL_TABS/);
  assert.match(source, /data-companion-send-row="true" className="app-composer-meta mt-2 flex items-center justify-between gap-4 pt-2\.5"/);
  assert.doesNotMatch(sidePanelHeader, /data-side-chat-session-detail-toggle="true"/);
  assert.match(source, /data-companion-attachment-control="true"/);
  assert.doesNotMatch(source, /shrink-0 border-t border-white\/\[0\.06\] px-5 pb-4 pt-3/);
  assert.doesNotMatch(source, /bg-\[#1f1f1f\]/);
  assert.match(source, /data-side-chat-options-menu="true"[^>]+bg-\[var\(--app-modal-bg\)\]/s);
  assert.match(source, /data-side-chat-options-menu="true"[^>]+text-\[color:var\(--utility-foreground\)\]/s);
  assert.match(source, /text-\[13px\]/);
  assert.match(source, />\s*New chat\s*</);
  assert.match(source, />\s*Switch Chat\s*</);
  assert.match(source, /data-side-chat-session-list="true"/);
  assert.match(source, />\s*Back\s*</);
  assert.doesNotMatch(source, /aria-label="Change side chat"/);
  assert.doesNotMatch(source, /<span>Close side chat<\/span>/);
  assert.doesNotMatch(source, />\s*New agent session\s*</);
  assert.doesNotMatch(source, />\s*New session\s*</);
  assert.doesNotMatch(source, /Ask co-pilot|Co-pilot|Private helper|Ask privately|data-chat-copilot-scope/);
  assert.doesNotMatch(source, /const companionConversation =[^;]+\?\? suggestedCompanionConversation/s);
});

test('ask agent slash trigger opens the side session instead of sending slash text to main chat', () => {
  const source = readFileSync(new URL('../src/pages/ChatsPage.tsx', import.meta.url), 'utf8');

  assert.match(source, /const handleSendChatMessage = \(draftOverride\?: string\) =>/);
  assert.match(source, /parseAskAgentTriggerCommand\(draft\)/);
  assert.match(source, /openSideAgentPanel\(trigger\.prompt\)/);
  assert.match(source, /void openSideAgentPanel\(trigger\.prompt\)\.then/);
  assert.match(source, /onSendChatMessage\(draftOverride\)/);
});

test('ask agent from an active agent chat creates a fresh side session instead of switching the main agent session', () => {
  const pageSource = readFileSync(new URL('../src/pages/ChatsPage.tsx', import.meta.url), 'utf8');
  const appModelSource = readFileSync(new URL('../src/app/useKordiAppModel.ts', import.meta.url), 'utf8');

  assert.match(pageSource, /activePaneKind === 'agent' && onCreateAgentSession/);
  assert.match(pageSource, /createSideAgentSession\(initialPrompt\)/);
  assert.match(appModelSource, /const previousActiveSessionId = desktopChatState\?\.activeSessionId \?\? null/);
  assert.match(appModelSource, /activeSessionId: previousActiveSessionId/);
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

  assert.match(source, /onSendChatMessage\(draft, conversation\.id, contextMessages\)/);
  assert.doesNotMatch(source, /User request:\\n\$\{draft\}/);
  assert.match(source, /event\.key === 'Enter' && !event\.metaKey && !event\.ctrlKey && !event\.shiftKey/);
  assert.match(source, /title=\{`Send to \$\{companionConversation\.name\}`\}/);
});

test('ask agent side transcript renders the same live turn and tool UI as My agent chat', () => {
  const source = readFileSync(new URL('../src/pages/ChatsPage.tsx', import.meta.url), 'utf8');

  assert.match(source, /const rawCompanionTranscriptLiveTurn = companionConversation\?\.previewLiveTurn \?\? undefined/);
  assert.match(source, /const companionTranscriptLiveTurn = rawCompanionTranscriptLiveTurn && companionConversation/);
  assert.match(source, /suppressLiveTurnEchoMessages\(\s*companionConversation\.messages, companionTranscriptLiveTurn/s);
  assert.match(source, /buildReplyAttribution\(messages, companionTranscriptLiveTurn/);
  assert.match(source, /attributedCompanionTranscriptLiveTurn/);
  assert.match(source, /<ChatSessionPane[\s\S]*liveTurn=\{attributedCompanionTranscriptLiveTurn\}/);
});

test('human panes do not show agent model controls while agent side panes use agent placeholder', () => {
  const source = readFileSync(new URL('../src/pages/ChatsPage.tsx', import.meta.url), 'utf8');

  assert.match(source, /activePaneKind === 'agent' && !activeConversationIsBridge/);
  assert.match(source, /companionPaneKind === 'agent' \? 'Ask the agent…'/);
  assert.match(source, /companionShowsLocalAgentControls/);
  assert.match(source, /companionPaneKind === 'agent' && !companionConversationHasBridgeTransport/);
  assert.match(source, /contextStatus=\{companionRuntimeContextStatus\}/);
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
