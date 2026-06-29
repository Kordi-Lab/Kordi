import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const chatsPageSource = () => readFileSync(new URL('../src/pages/ChatsPage.tsx', import.meta.url), 'utf8');
const chatMessagesSource = () => readFileSync(new URL('../src/features/chat/messageActions/chatMessages.ts', import.meta.url), 'utf8');
const messageTypesSource = () => readFileSync(new URL('../src/kordi-app/types/message.ts', import.meta.url), 'utf8');
const appModelSource = () => readFileSync(new URL('../src/app/useKordiAppModel.ts', import.meta.url), 'utf8');

function blockBetween(source: string, startNeedle: string, endNeedle: string): string {
  const start = source.indexOf(startNeedle);
  assert.notEqual(start, -1, `missing start marker: ${startNeedle}`);
  const end = source.indexOf(endNeedle, start);
  assert.notEqual(end, -1, `missing end marker after ${startNeedle}: ${endNeedle}`);
  return source.slice(start, end);
}

function sidePanelBlock(source: string): string {
  return blockBetween(source, 'data-chat-side-agent-panel="true"', 'const splitDivider = showCompanionPane');
}

test('side-panel Agent chat renders the same reusable session pane as the main Agent chat', () => {
  const source = chatsPageSource();
  const side = sidePanelBlock(source);

  assert.match(source, /function ChatSessionPane\b|const ChatSessionPane\b/, 'expected one shared ChatSessionPane implementation');
  assert.equal((source.match(/<ChatSessionPane\b/g) ?? []).length, 2, 'main and side-panel Agent chats should both render through ChatSessionPane');
  assert.equal((source.match(/<ChatComposerShell\b/g) ?? []).length, 2, 'main and side-panel Agent chats should both render through ChatComposerShell');
  assert.match(side, /<ChatSessionPane\b/, 'side-panel Agent chat should render through ChatSessionPane');
  assert.match(side, /data-side-chat-controls="true"/, 'side panel should retain its placement-specific options and close controls');
  assert.match(side, /aria-label="Side chat options"/, 'side panel should retain the ellipsis options button');
  assert.match(side, /aria-label="Close side chat"/, 'side panel should retain the close button');
  assert.doesNotMatch(side, /companionTranscriptMessages\.map\(\(msg, idx\) => \(\s*<MessageBubble\b/s, 'side panel must not keep a bespoke MessageBubble transcript');
  assert.doesNotMatch(side, /<textarea[\s\S]*data-composer-scope="companion"/, 'side panel must not keep a bespoke composer textarea');
});

test('shared Agent session pane and composer include transcript, attachments, forwarding, details, and right expansion hooks', () => {
  const source = chatsPageSource();
  const paneStart = source.search(/function ChatSessionPane\b|const ChatSessionPane\b/);
  assert.notEqual(paneStart, -1, 'expected a shared ChatSessionPane implementation');
  const pane = source.slice(paneStart, paneStart + 10000);

  for (const required of [
    'MessageBubble',
    'LiveChatTurnMessage',
    'onReplyMessage',
    'onForwardMessage',
    'onSelectMessage',
    'onNavigateToMessage',
  ]) {
    assert.match(pane, new RegExp(required), `shared Agent session pane should include ${required}`);
  }

  for (const required of [
    'ChatComposerShell',
    'chatComposerAttachments',
    'saveDesktopAttachments',
    'saveDesktopAttachmentPaths',
    'removeChatComposerAttachment',
    'onOpenMessageDetail',
    'rightDetailRail',
    'setIsDetailPanelCollapsed',
  ]) {
    assert.match(source, new RegExp(required), `shared Agent session wiring should include ${required}`);
  }
});

test('side-panel Agent composer exposes the same visible attachment trigger and aligned composer controls as main chat', () => {
  const source = chatsPageSource();
  const side = sidePanelBlock(source);

  assert.match(side, /ref=\{companionAttachmentInputRef\}/, 'side-panel file input should have its own ref, not a hidden unreachable input');
  assert.match(side, /onClick=\{\(\) => companionAttachmentInputRef\.current\?\.click\(\)\}/, 'side-panel composer should expose a visible attachment button');
  assert.match(side, /aria-label="Add attachment"/, 'side-panel attachment control should use the same accessible label as main composer');
  assert.match(side, /data-companion-attachment-control="true"/, 'side-panel attachment control should be identifiable for parity regression coverage');
  assert.match(side, /data-companion-composer-frame="true"[\s\S]*shrink-0 px-5 pb-4 pt-3/, 'side-panel composer should use the same outer frame spacing as the main composer so input blocks align');
  assert.match(side, /data-companion-send-row="true"[\s\S]*items-center justify-between gap-3 pt-2\.5/, 'side-panel composer controls should keep the same baseline rhythm while fitting narrow split panes');
  assert.doesNotMatch(side, /<span className="h-9 w-9 shrink-0" aria-hidden="true" \/>/, 'side-panel composer should not use a blank spacer instead of the real attachment controls');
});

test('side-panel Agent model controls use independent menu state and target the side session', () => {
  const source = chatsPageSource();
  const side = sidePanelBlock(source);

  assert.match(source, /const \[companionOpenComposerSelector, setCompanionOpenComposerSelector\]/, 'side-panel model selector should not share the main composer open state');
  assert.match(source, /toggleCompanionComposerSelector/, 'side-panel model selector should have its own toggle handler');
  assert.match(side, /openSelector=\{companionOpenComposerSelector\}/, 'side-panel model controls should read side-panel selector state');
  assert.match(side, /onToggleSelector=\{toggleCompanionComposerSelector\}/, 'side-panel model controls should toggle side-panel selector state');
  assert.match(side, /selectComposerValue\(scope, type, value, companionConversation\.id\)/, 'side-panel model changes should target the side-panel session id');
  assert.match(side, /selectComposerProviderChoice\(scope, option, companionConversation\.id\)/, 'side-panel provider changes should target the side-panel session id');
  assert.doesNotMatch(side, /openSelector=\{openComposerSelector\}/, 'side-panel model controls must not share the main composer popover state');
});

test('side-panel cloud Agent model controls clone main bridge-routing menu behavior', () => {
  const source = chatsPageSource();
  const side = sidePanelBlock(source);
  const appModel = appModelSource();

  assert.match(source, /const \[selectedCompanionBridgeAgentId, setSelectedCompanionBridgeAgentId\]/, 'side-panel bridge agent menu should not share main bridge routing selection');
  assert.match(source, /const companionBridgeRoutingAgents = useMemo/, 'side-panel bridge agent menu should derive routing agents for the companion session');
  assert.match(side, /companionConversationIsBridgeAgent[\s\S]*selectedCompanionBridgeRoutingAgent/, 'side-panel cloud agents should render a bridge-routing model branch');
  assert.match(side, /selection=\{companionBridgeRoutingSelection\}/, 'side-panel cloud agent model controls should use bridge routing selection');
  assert.match(side, /updateCompanionBridgeAgentRouting\(\{[\s\S]*defaultModel: value/, 'side-panel cloud agent model changes should update bridge routing');
  assert.match(side, /onSelectProviderChoice=\{\(_scope, option\) => \{[\s\S]*updateCompanionBridgeAgentRouting/, 'side-panel cloud agent provider changes should update bridge routing');
  assert.match(source, /const companionBridgeRoutingTargetSessionId = companionConversation\?\.canonicalSessionId \?\? companionConversation\?\.id \?\? null/, 'side-panel bridge routing should resolve the companion session id, not the active main session');
  assert.match(source, /onUpdateBridgeAgentModelRouting\([\s\S]*nextFallbackAuthChoice,\s*companionBridgeRoutingTargetSessionId,\s*\)/, 'side-panel cloud route changes should pass the companion session id through the bridge routing callback');
  assert.match(appModel, /targetSessionIdOverride\?: string \| null/, 'cloud bridge route updater should accept an explicit target session override');
  assert.match(appModel, /targetSessionIdOverride\?\.trim\(\)\s*\|\|\s*activeConv\.canonicalSessionId/, 'cloud bridge route updater should prefer the explicit side-panel session id before falling back to activeConv');
  assert.doesNotMatch(side, /companionPaneKind === 'agent' && !companionConversationHasBridgeTransport[\s\S]*<ComposerModelControls/, 'side-panel model menu must not disappear for bridge-backed agent sessions');
});

test('split-pane Agent bottom controls stay compact without changing composer height during resize', () => {
  const source = chatsPageSource();
  const side = sidePanelBlock(source);
  const main = blockBetween(source, '<ChatSessionPane\n        messages={attributedTranscriptMessages}', '{showCompanionPane && companionSide === \'right\' ? splitDivider : null}');
  const composerSource = readFileSync(new URL('../src/kordi-app/components/composer.tsx', import.meta.url), 'utf8');

  assert.match(composerSource, /compact\?: boolean/, 'ComposerModelControls should expose a compact density for narrow panes');
  assert.match(side, /scrollClassName="min-h-0 flex-1 overflow-x-hidden overscroll-contain px-3 py-5"/, 'side-panel transcript should flex like the main pane while preserving overflow containment so composer bottoms stay aligned during resize');
  assert.match(side, /data-companion-send-row="true"[\s\S]*flex-nowrap/, 'side-panel send row should stay single-line so resizing does not change composer height');
  assert.match(side, /data-companion-model-controls="true"[\s\S]*flex-nowrap/, 'side-panel model controls should stay single-line instead of wrapping under the input');
  assert.match(side, /<ComposerModelControls[\s\S]*compact=\{true\}/, 'side-panel model controls should use compact button widths');
  assert.match(main, /className=\{cn\('flex min-w-0 items-center overflow-visible'[\s\S]*showCompanionPane \? 'shrink gap-2' : 'shrink-0 gap-3'\)\}/, 'main split-pane composer controls should be allowed to shrink when a companion pane is open');
  assert.match(main, /<ComposerModelControls[\s\S]*compact=\{showCompanionPane\}/, 'main split-pane model controls should also use compact widths');
  assert.match(composerSource, /compact \? 'w-\[5\.75rem\]' : 'w-\[8\.75rem\]'/, 'compact provider button width should be narrow enough for split panes');
});

test('split-pane Agent model selection menu escapes the right panel clipping boundary', () => {
  const composerSource = readFileSync(new URL('../src/kordi-app/components/composer.tsx', import.meta.url), 'utf8');
  const popoversSource = readFileSync(new URL('../src/styles/shell-popovers.css', import.meta.url), 'utf8');
  const controlsStart = composerSource.indexOf('export function ComposerModelControls');
  assert.notEqual(controlsStart, -1, 'ComposerModelControls should exist');
  const controlsSource = composerSource.slice(controlsStart);

  assert.match(controlsSource, /getBoundingClientRect\(\)/, 'model selector should measure its trigger for viewport-aware placement');
  assert.match(controlsSource, /app-composer-model-menu-layer fixed/, 'model selector menu should be fixed-positioned so overflow-hidden panes do not clip it');
  assert.match(controlsSource, /createPortal\(renderSelectorMenu\(\), document\.body\)/, 'model selector menu should render through a body portal');
  assert.match(popoversSource, /\.app-composer-model-menu-layer \{[\s\S]*--app-modal-bg:/, 'body-portaled selector should define its own dark theme variables');
  assert.match(popoversSource, /\.app-composer-model-menu-layer\.app-compact-model-menu-light \{[\s\S]*--app-modal-bg:/, 'body-portaled selector should define its own light theme variables');
  assert.doesNotMatch(controlsSource, /absolute bottom-full right-0 z-30 mb-2 max-h-\[min\(28rem,60vh\)\] w-\[340px\]/, 'model selector menu must not stay absolute inside the right-panel composer');
});

test('side-panel Agent session omits the header session Details button', () => {
  const source = chatsPageSource();
  const paneStart = source.search(/function ChatSessionPane\b|const ChatSessionPane\b/);
  assert.notEqual(paneStart, -1, 'expected a shared ChatSessionPane implementation');
  const pane = source.slice(paneStart, paneStart + 10000);
  const side = sidePanelBlock(source);

  assert.match(pane, /onOpenMessageDetail,/, 'ChatSessionPane should destructure onOpenMessageDetail');
  assert.match(pane, /onOpenMessageDetail=\{onOpenMessageDetail\}/, 'ChatSessionPane should pass message detail handling into MessageBubble');
  assert.doesNotMatch(side, /data-side-chat-session-detail-toggle="true"/, 'side-panel header should not show a session Details button');
  assert.doesNotMatch(side, /isCompanionDetailPanelCollapsed \? 'Details' : 'Hide details'/, 'side-panel header should not render Details/Hide details text');
  assert.match(source, /companionInlineDetailRail\s*=\s*showCompanionDetailRail\s*&&\s*!isCompanionDetailPanelCollapsed/, 'side-panel session should still have its own inline detail rail state for message details');
  assert.match(source, /const \[companionActiveDetailTab, setCompanionActiveDetailTab\] = useState<DetailTab>\('info'\)/, 'side-panel detail rail should not share the main activeDetailTab state');
  assert.match(source, /const \[companionActiveArtifactId, setCompanionActiveArtifactId\] = useState<string \| null>\(null\)/, 'side-panel detail rail should not share the main activeArtifactId state');
  assert.match(source, /activeDetailTab=\{companionActiveDetailTab\}/, 'side-panel detail rail should render using the side-panel detail tab');
  assert.match(source, /activeArtifactId=\{companionActiveArtifactId\}/, 'side-panel detail rail should render using the side-panel artifact selection');
  assert.match(source, /data-chat-companion-detail-rail="true"/, 'side-panel detail rail should render as a companion rail, not the main middle rail');
  assert.match(source, /\{showCompanionPane && companionSide === 'right' \? companionPane : null\}\s*\{showCompanionPane && companionSide === 'right' \? companionInlineDetailRail : null\}/s, 'right-side companion detail rail should render to the right of the side panel');
});

test('sending from main or side-panel chat schedules a jump to the sent message', () => {
  const source = chatsPageSource();

  assert.match(source, /scrollTranscriptToBottom/, 'ChatsPage should use the transcript bottom-scroll helper after sends');
  const mainSendStart = source.indexOf('const handleSendChatMessage = (draftOverride?: string) => {');
  const splitStart = source.indexOf('const updateSplitFromPointer', mainSendStart);
  assert.notEqual(mainSendStart, -1, 'main chat send handler should exist');
  assert.notEqual(splitStart, -1, 'main chat send block should have an end boundary');
  const mainSendBlock = source.slice(mainSendStart, splitStart);
  assert.match(mainSendBlock, /scheduleTranscriptScrollToBottom\(chatTranscriptScrollRef\)/, 'main send should jump its own transcript to the new message');

  const sideSendStart = source.indexOf('const sendCompanionDraft = (conversation: Conversation) => {');
  const createSideStart = source.indexOf('const createSideAgentSession', sideSendStart);
  assert.notEqual(sideSendStart, -1, 'side-panel send handler should exist');
  assert.notEqual(createSideStart, -1, 'side-panel send block should have an end boundary');
  const sideSendBlock = source.slice(sideSendStart, createSideStart);
  assert.match(sideSendBlock, /scheduleTranscriptScrollToBottom\(companionTranscriptScrollRef\)/, 'side-panel send should jump its own transcript to the new message');
});

test('side-panel queued local-agent sends preserve draft visibility and reference context while a turn is running', () => {
  const chatsSource = chatsPageSource();
  const actionsSource = chatMessagesSource();
  const typesSource = messageTypesSource();

  const side = sidePanelBlock(chatsSource);
  assert.match(side, /queuedMessages=\{queuedDesktopMessagesBySession\[companionConversation\.id\] \?\? \[\]\}/, 'side-panel transcript should render queued drafts for its own session');

  assert.match(typesSource, /contextMessages\?: DesktopChatContextMessage\[\]/, 'queued local messages should preserve optional side Agent reference context');

  const targetedStart = actionsSource.indexOf('const sendTargetedChatMessage = useCallback');
  const activeStart = actionsSource.indexOf('return useCallback', targetedStart);
  assert.notEqual(targetedStart, -1, 'targeted side-panel send path should exist');
  assert.notEqual(activeStart, -1, 'active send path should exist after targeted send path');
  const targetedSendBlock = actionsSource.slice(targetedStart, activeStart);
  assert.match(targetedSendBlock, /if \(delayReason === 'same-session-running'\) \{[\s\S]*queueLocalDraftForSession\(targetConversation\.id, text, chatComposerAttachments, contextMessages\)/, 'side-panel local sends should queue while the target session is running instead of showing the preparing error');
  assert.match(targetedSendBlock, /if \(delayReason === 'same-session-running'\) \{[\s\S]*return;[\s\S]*\}\s*if \(delayReason\) \{[\s\S]*Kordi is still preparing this session/, 'side-panel send should only fall back to the preparing error after the same-session queue case');
  assert.match(actionsSource, /startDesktopChatMessage\(message\.sessionId, message\.text, attachmentPaths, null, message\.contextMessages \?\? \[\]\)/, 'flushing queued side messages should send their preserved reference context');
});

test('side-panel local-agent sends use the shared local send pipeline instead of duplicating optimistic persistence', () => {
  const source = chatMessagesSource();
  const targetedStart = source.indexOf('const sendTargetedChatMessage = useCallback');
  const activeStart = source.indexOf('return useCallback', targetedStart);
  assert.notEqual(targetedStart, -1, 'targeted side-panel send path should exist');
  assert.notEqual(activeStart, -1, 'active send path should exist after targeted send path');
  const targetedSendBlock = source.slice(targetedStart, activeStart);
  const activeSendBlock = source.slice(activeStart);
  const localBranchStart = targetedSendBlock.indexOf('const delayReason = localChatSendDelayReason');
  assert.notEqual(localBranchStart, -1, 'targeted local-agent branch should exist');
  const targetedLocalBranch = targetedSendBlock.slice(localBranchStart);

  assert.match(source, /sendLocalAgentChatMessage/, 'expected a shared local-agent send helper used by active and side-panel sends');
  assert.match(targetedLocalBranch, /sendLocalAgentChatMessage\(/, 'side-panel local-agent sends should call the shared helper');
  assert.match(activeSendBlock, /sendLocalAgentChatMessage\(/, 'main chat sends should call the same shared helper');
  assert.doesNotMatch(targetedLocalBranch, /prepareCanonicalUserMessage\(/, 'side-panel local-agent branch should not duplicate canonical optimistic message construction');
});
