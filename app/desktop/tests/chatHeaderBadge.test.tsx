import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  chatCompanionCandidates,
  chatCompanionSideForPaneKinds,
  chatCompanionSideFromDropPosition,
  buildAskAgentSessionReferenceContext,
  chatSideAgentConversationForOpenRequest,
  humanSideForCompanionSide,
  pairedCompanionConversation,
  parseAskAgentTriggerCommand,
} from '../src/pages/ChatsPage';
import type { Conversation } from '../src/kordi-app/types';
import { readKordiAppModelImplementationSource } from './helpers/appModelSource';
import { readDesktopShellCss } from './helpers/readDesktopStyles';

function readChatsPageImplementationSource(): string {
  return [
    '../src/pages/ChatsPage.tsx',
    '../src/pages/chatsPage.destinations.tsx',
    '../src/pages/chatsPage.destinationModel.ts',
    '../src/pages/chatsPage.companionComposer.tsx',
    '../src/pages/chatsPage.companionDestination.tsx',
    '../src/pages/chatsPage.companionHeader.tsx',
    '../src/pages/chatsPage.companionPane.tsx',
    '../src/pages/chatsPage.companionWorkspace.tsx',
    '../src/pages/chatsPage.mainComposer.tsx',
    '../src/pages/chatsPage.mainHeader.tsx',
    '../src/pages/chatsPage.mainWorkspace.tsx',
    '../src/pages/chatsPage.model.ts',
    '../src/pages/chatsPage.sessionPane.tsx',
    '../src/pages/useChatCompanionLayout.ts',
    '../src/pages/useChatCompanionSession.ts',
    '../src/pages/useChatDestinations.ts',
    '../src/pages/useChatHeaderModel.ts',
  ]
    .map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'))
    .join('\n');
}

function conversation(overrides: Partial<Conversation>): Conversation {
  return {
    id: 'conversation',
    name: 'Conversation',
    type: 'person',
    subtitle: '',
    unread: 0,
    collaborationSources: [],
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
  const source = readChatsPageImplementationSource();

  assert.match(source, /function chatTranscriptDensityMode\(conversation: Conversation\)/);
  assert.match(source, /conversationUsesCompactHumanTranscriptDensity\(conversation\)/);
  assert.match(source, /densityMode: chatTranscriptDensityMode\(activeConv\)/);
  assert.match(source, /densityMode: chatTranscriptDensityMode\(conversation\)/);
  assert.match(source, /if \(conversationIsAgentChat\(conversation\)\) return 'agent-compact';/);
  assert.match(source, /if \(conversationIsGroupChat\(conversation\)\) return 'group-compact';/);
  assert.match(source, /return 'contact-compact'/);
  assert.match(source, /return 'default'/);
});

test('chat header title text does not flex-grow away from fork or action pills', () => {
  const source = readFileSync(new URL('../src/pages/chatsPage.mainHeader.tsx', import.meta.url), 'utf8');

  assert.doesNotMatch(source, /min-w-\[12rem\] max-w-full flex-1 break-words/);
  assert.doesNotMatch(source, /min-w-\[10rem\] flex-1 break-words/);
});

test('renameable chat title owns the available line before truncating its text', () => {
  const source = readFileSync(new URL('../src/pages/chatsPage.mainHeader.tsx', import.meta.url), 'utf8');

  assert.match(source, /<h2 className="min-w-0 w-full text-\[17px\]/);
  assert.doesNotMatch(source, /<h2 className="[^"]*max-w-/);
  assert.doesNotMatch(source, /<input[\s\S]*?className="[^"]*max-w-\[32rem\]/);
  assert.match(source, /app-button-quiet -ml-1 inline-block max-w-full truncate/);
  assert.doesNotMatch(source, /app-button-quiet -ml-1 block w-full truncate/);
});

test('chat headers reserve a compact second row for quiet metadata', () => {
  const source = readChatsPageImplementationSource();
  const shell = readDesktopShellCss();

  assert.doesNotMatch(source, /min-h-\[112px\]/);
  assert.doesNotMatch(source, /min-h-\[100px\]/);
  assert.equal((source.match(/app-page-header app-chat-pane-header/g) ?? []).length, 2, 'main and Ask Agent headers should share one geometry contract');
  assert.match(shell, /\.app-chat-split-workspace\s*{[^}]*--app-chat-pane-header-height:\s*5\.75rem;/s);
  assert.match(shell, /\.app-right-detail-page-content\s*{[^}]*padding:\s*var\(--app-chat-pane-detail-top\) var\(--app-chat-pane-detail-inline\) 2\.5rem;/s);
  assert.match(source, /data-chat-session-metadata="true"/);
  assert.match(source, /data-chat-session-subtitle="true"/);
  assert.doesNotMatch(source, /data-chat-session-subtitle-pill="true"/);
  assert.match(source, /data-chat-destination-tabs=\{scope\}/);
  assert.match(source, /icon: MessageSquare/);
  assert.match(source, /icon: Info/);
  assert.match(source, /icon: FolderOpen/);
  assert.match(source, /icon: CheckCircle2/);
  assert.equal((source.match(/app-chat-pane-metadata-row/g) ?? []).length, 2);
  assert.match(source, /data-chat-session-subtitle="true"[^>]*className="app-chat-pane-metadata-row[^>]*>Agent session/);
});

test('Ask Agent remains a flat utility action while chat details move into destination subtitles', () => {
  const chatSource = readFileSync(new URL('../src/pages/chatsPage.mainHeader.tsx', import.meta.url), 'utf8');
  const projectSource = readFileSync(new URL('../src/pages/ProjectsPage.tsx', import.meta.url), 'utf8');
  const askAgentButton = chatSource.slice(chatSource.indexOf('aria-label="Ask Agent"') - 360, chatSource.indexOf('aria-label="Ask Agent"') + 180);
  const projectDetailsButton = projectSource.slice(projectSource.indexOf('aria-label={isDetailPanelCollapsed') - 260, projectSource.indexOf('aria-label={isDetailPanelCollapsed') + 180);

  assert.doesNotMatch(`${askAgentButton}\n${projectDetailsButton}`, /border-pink|bg-white\/\[0\.06\]|text-pink|text-slate-100/);
  assert.match(askAgentButton, /variant="quiet"/);
  assert.match(askAgentButton, /className="app-utility-button[^"]*font-medium"/);
  assert.match(projectDetailsButton, /className="app-utility-button[^"]*font-medium/);
  assert.doesNotMatch(chatSource, /Open session details|Hide session details|>\s*Hide details\s*</);
});

test('chat destination pages do not reserve a resizable right-rail width', () => {
  const layoutSource = readFileSync(new URL('../src/app/useAppLayoutState.ts', import.meta.url), 'utf8');

  assert.match(layoutSource, /const showResizableRightDetailRail = activeNav === 'projects';/);
  assert.match(layoutSource, /showResizableRightDetailRail && !isDetailPanelCollapsed\s*\? clampDetailPanelWidth/);
  assert.match(layoutSource, /showRightDetailRail: showResizableRightDetailRail/);
});

test('message selection control is smaller than the old oversized blue circle', () => {
  const source = readFileSync(new URL('../src/kordi-app/components/transcript.tsx', import.meta.url), 'utf8');

  assert.doesNotMatch(source, /app-message-selection-control grid h-6\.5 w-6\.5/);
  assert.match(source, /app-message-selection-control grid h-5\.5 w-5\.5/);
  assert.match(source, /<Check className="h-3 w-3"/);
});

test('chat header permanently omits the decorative Cloud sync presentation', () => {
  const source = readChatsPageImplementationSource();

  assert.doesNotMatch(source, /data-cloud-self-agent-sync-status/);
  assert.doesNotMatch(source, /cloudSyncLabel|cloudSyncStatus/);
  assert.doesNotMatch(source, /<Cloud\b/);
});

test('chat header presents fork provenance as a quiet metadata action', () => {
  const source = readFileSync(new URL('../src/pages/chatsPage.mainHeader.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('app-fork-source-link');
  const markup = source.slice(start - 120, source.indexOf('</button>', start));

  assert.match(markup, /app-button-quiet app-fork-source-link/);
  assert.match(markup, /Forked from \{metadata\.forkSourceTitle\}/);
  assert.match(markup, /aria-label=\{`Open source session/);
  assert.doesNotMatch(markup, /rounded-full|border-white|bg-white/);
});

test('chat companion pairing links human chats to that human owner agent chat', () => {
  const humanChat = conversation({
    id: 'human-chat',
    name: 'Jiaxin',
    type: 'person',
    collaborationTarget: {
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
      sourceHostId: 'cloud',
      sourceIdentityId: 'acct_jiaxin',
      humanId: 'acct_jiaxin',
    }],
  });
  const ownerAgentChat = conversation({
    id: 'agent-chat',
    name: 'Jiaxin Agent',
    type: 'external-agent',
    collaborationTarget: {
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
      sourceHostId: 'cloud',
      sourceIdentityId: 'agent_jiaxin',
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
    collaborationTarget: {
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
      sourceHostId: 'cloud',
      sourceIdentityId: 'acct_shu',
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
  const source = readChatsPageImplementationSource();

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
  const source = readChatsPageImplementationSource();
  const sidePanelHeader = readFileSync(
    new URL('../src/pages/chatsPage.companionHeader.tsx', import.meta.url),
    'utf8',
  );

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
  assert.equal((sidePanelHeader.match(/app-button-quiet/g) ?? []).length, 2);
  assert.match(source, /data-side-chat-root-menu="true"/);
  assert.match(source, /app-page-header[^"`]*z-40/);
  assert.match(source, /data-side-chat-options-menu="true"/);
  assert.match(source, /z-50/);
  assert.match(source, /scope="main"/);
  assert.match(source, /scope="companion"/);
  assert.match(source, /data-chat-destination-page=\{destination\}/);
  assert.doesNotMatch(source, /data-chat-inline-detail-rail="true"/);
  assert.doesNotMatch(source, /ownInlineDetailRail|companionInlineDetailRail/);
  assert.match(source, /data-companion-composer-footer="true"/);
  assert.match(source, /data-companion-send-row="true"/);
  assert.match(source, /data-companion-send-control="true"/);
  assert.match(source, /data-companion-model-controls="true"/);
  assert.doesNotMatch(source, /data-companion-detail-toggle/);
  assert.doesNotMatch(source, /data-chat-side-detail-rail/);
  assert.doesNotMatch(source, /setIsCompanionDetailOpen/);
  assert.doesNotMatch(source, /CHAT_SIDE_DETAIL_TABS/);
  assert.match(source, /data-companion-send-row="true" className="app-composer-meta mt-2 flex flex-nowrap items-center justify-between gap-3 pt-2\.5"/);
  assert.doesNotMatch(sidePanelHeader, /data-side-chat-session-detail-toggle="true"/);
  assert.match(source, /data-companion-attachment-control="true"/);
  assert.doesNotMatch(source, /shrink-0 border-t border-white\/\[0\.06\] px-5 pb-4 pt-3/);
  assert.doesNotMatch(source, /bg-\[#1f1f1f\]/);
  assert.match(source, /data-side-chat-options-menu="true"[^>]+app-transient-surface/s);
  assert.doesNotMatch(source, /data-side-chat-options-menu="true"[^>]+bg-\[var\(--app-modal-bg\)\]/s);
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
  const source = readFileSync(
    new URL('../src/pages/chatsPage.mainWorkspace.tsx', import.meta.url),
    'utf8',
  );

  assert.match(source, /const handleSend = \(draftOverride\?: string\) =>/);
  assert.match(source, /parseAskAgentTriggerCommand\(draft\)/);
  assert.match(source, /void companion\.open\(trigger\.prompt\)\.then/);
  assert.match(source, /runtime\.onSendChatMessage\(draftOverride\)/);
});

test('ask agent from an active agent chat creates a fresh side session instead of switching the main agent session', () => {
  const pageSource = readFileSync(
    new URL('../src/pages/useChatCompanionSession.ts', import.meta.url),
    'utf8',
  );
  const appModelSource = readKordiAppModelImplementationSource();
  const sideAgentActionsSource = readFileSync(new URL('../src/app/useKordiSideAgentSessionActions.ts', import.meta.url), 'utf8');

  assert.match(pageSource, /activePaneKind === 'agent' && onCreateAgentSession/);
  assert.match(pageSource, /return create\(initialPrompt\)/);
  assert.match(
    appModelSource,
    /mainConversationId:\s*conversations\.activeConv\.id/,
  );
  assert.match(sideAgentActionsSource, /setDesktopChatState\(nextState\)/);
  assert.doesNotMatch(sideAgentActionsSource, /\{ \.\.\.nextState, activeSessionId:/);
});

test('ask agent new session action switches the side panel to the created agent session', () => {
  const source = readFileSync(
    new URL('../src/pages/useChatCompanionSession.ts', import.meta.url),
    'utf8',
  );

  assert.match(source, /const conversationId = await onCreateAgentSession\(\)/);
  assert.match(source, /activate\(conversationId, initialPrompt\)/);
  assert.match(source, /selectedConversationId: conversationId,[\s\S]*openConversationId: conversationId/);
});

test('chat companion pane does not expose focus handoff controls', () => {
  const source = readFileSync(new URL('../src/pages/ChatsPage.tsx', import.meta.url), 'utf8');

  assert.doesNotMatch(source, /openCompanionDraft/);
  assert.doesNotMatch(source, /Focus \$\{companionConversation\.name\}/);
  assert.doesNotMatch(source, /to send this draft/);
});

test('chat companion composer sends with Enter and keeps modified Enter for line breaks', () => {
  const source = readChatsPageImplementationSource();

  assert.match(source, /onSendChatMessage\(\s*draft,\s*targetConversation\.id,\s*referenceMessage \? \[referenceMessage\] : \[\],\s*\)/);
  assert.doesNotMatch(source, /User request:\\n\$\{draft\}/);
  assert.match(source, /event\.key === 'Enter' && !event\.metaKey && !event\.ctrlKey && !event\.shiftKey/);
  assert.match(source, /title=\{`Send to \$\{conversation\.name\}`\}/);
});

test('ask agent side transcript renders live turns after authoritative history is ready', () => {
  const source = readChatsPageImplementationSource();

  assert.match(source, /const rawCompanionTranscriptLiveTurn = companionConversation\?\.previewLiveTurn \?\? undefined/);
  assert.match(source, /const companionTranscriptLiveTurn = rawCompanionTranscriptLiveTurn && companionConversation/);
  assert.match(source, /suppressLiveTurnEchoMessages\(\s*companionConversation\.messages, companionTranscriptLiveTurn/s);
  assert.match(source, /buildReplyAttribution\(\s*messages,\s*shouldRenderLiveTurn \? liveTurn : null/s);
  assert.match(source, /sessionPane=\{\{[\s\S]*liveTurn: presentation\.liveTurn/);
  assert.match(source, /shouldRenderLiveTurn: Boolean\(\s*!session\.transcript\.isLoading\s*&& presentation\.liveTurn\s*&& !presentation\.liveTurn\.completed/s);
});

test('human panes do not show agent model controls while agent side panes use agent placeholder', () => {
  const source = readChatsPageImplementationSource();

  assert.match(source, /localRouting\.paneKind === 'agent'[\s\S]*&& !collaborationRouting\.enabled/);
  assert.match(source, /paneKind === 'agent' \? 'Ask the agent…'/);
  assert.match(source, /companionShowsLocalAgentControls/);
  assert.match(source, /companionConversationIsCollaborationAgent/);
  assert.match(source, /companionPaneKind === 'agent' && !companionConversationIsCollaborationAgent/);
  assert.match(source, /data-companion-collaboration-model-controls="true"/);
  assert.match(source, /contextStatus=\{localRouting\.runtimeContextStatus\}/);
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
