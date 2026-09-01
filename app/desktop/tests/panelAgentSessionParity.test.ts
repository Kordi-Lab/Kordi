import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { readKordiAppModelImplementationSource } from './helpers/appModelSource';

const chatsPageSource = () => [
  '../src/pages/ChatsPage.tsx',
  '../src/pages/chatsPage.destinations.tsx',
  '../src/pages/chatsPage.destinationModel.ts',
  '../src/pages/chatsPage.header.ts',
  '../src/pages/chatsPage.navigation.ts',
  '../src/pages/chatsPage.queuedMessage.tsx',
  '../src/pages/chatsPage.sessionPane.tsx',
  '../src/pages/chatsPage.companionComposer.tsx',
  '../src/pages/chatsPage.companionDestination.tsx',
  '../src/pages/chatsPage.companionHeader.tsx',
  '../src/pages/chatsPage.companionPane.tsx',
  '../src/pages/chatsPage.collaborationRoutingControls.tsx',
  '../src/pages/chatsPage.companionWorkspace.tsx',
  '../src/pages/chatsPage.mainWorkspace.tsx',
  '../src/pages/chatsPage.mainComposer.tsx',
  '../src/pages/useChatCollaborationRouting.ts',
  '../src/pages/useChatCompanionLayout.ts',
  '../src/pages/useChatCompanionSession.ts',
  '../src/pages/useChatDestinations.ts',
  '../src/pages/useChatForkModel.ts',
  '../src/pages/useChatHeaderModel.ts',
  '../src/pages/useChatPins.ts',
  '../src/pages/useChatSenderProfiles.ts',
  '../src/pages/useChatTranscriptNavigation.ts',
]
  .map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'))
  .join('\n');
const chatSessionPaneSource = () => readFileSync(new URL('../src/pages/chatsPage.sessionPane.tsx', import.meta.url), 'utf8');
const chatTranscriptViewportSource = () => readFileSync(new URL('../src/pages/chatsPage.transcriptViewport.tsx', import.meta.url), 'utf8');
const queuedMessageSource = () => readFileSync(new URL('../src/pages/chatsPage.queuedMessage.tsx', import.meta.url), 'utf8');
const chatMessagesSource = () => readFileSync(new URL('../src/features/chat/messageActions/chatMessages.ts', import.meta.url), 'utf8');
const messageTypesSource = () => readFileSync(new URL('../src/kordi-app/types/message.ts', import.meta.url), 'utf8');
const appModelSource = readKordiAppModelImplementationSource;
const collaborationNavigationActionsSource = () => readFileSync(new URL('../src/app/useKordiCollaborationNavigationActions.ts', import.meta.url), 'utf8');
const queuedMessageActionsSource = () => readFileSync(new URL('../src/app/useKordiQueuedMessageActions.ts', import.meta.url), 'utf8');
const virtualTranscriptSource = () => readFileSync(new URL('../src/features/chat/VirtualTranscript.tsx', import.meta.url), 'utf8');
const virtualTranscriptNavigationSource = () => readFileSync(new URL('../src/features/chat/useVirtualTranscriptNavigation.ts', import.meta.url), 'utf8');

function blockBetween(source: string, startNeedle: string, endNeedle: string): string {
  const start = source.indexOf(startNeedle);
  assert.notEqual(start, -1, `missing start marker: ${startNeedle}`);
  const end = source.indexOf(endNeedle, start);
  assert.notEqual(end, -1, `missing end marker after ${startNeedle}: ${endNeedle}`);
  return source.slice(start, end);
}

function sidePanelBlock(source: string): string {
  const composition = blockBetween(
    source,
    'const companionPane = companionConversation',
    'const splitDivider = <ChatCompanionSplitDivider',
  );
  return [
    composition,
    '../src/pages/chatsPage.companionComposer.tsx',
    '../src/pages/chatsPage.companionDestination.tsx',
    '../src/pages/chatsPage.companionHeader.tsx',
    '../src/pages/chatsPage.companionPane.tsx',
    '../src/pages/chatsPage.collaborationRoutingControls.tsx',
    '../src/pages/chatsPage.companionWorkspace.tsx',
    '../src/pages/useChatCompanionSession.ts',
    '../src/kordi-app/components/composerAttachments.tsx',
  ]
    .map((entry, index) => (
      index === 0 ? entry : readFileSync(new URL(entry, import.meta.url), 'utf8')
    ))
    .join('\n');
}

function chatSessionPaneBlock(): string {
  const source = chatSessionPaneSource();
  const start = source.indexOf('function ChatSessionPane');
  assert.notEqual(start, -1, 'missing shared ChatSessionPane implementation');
  return [source.slice(start), chatTranscriptViewportSource()].join('\n');
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

test('model route changes use transcript notices instead of private composer notices', () => {
  const source = chatsPageSource();

  assert.doesNotMatch(source, /Private · \{collaborationRouting\.notice\}/);
  assert.doesNotMatch(source, /collaborationRouting\.notice \? \(/);
});

test('side-panel destinations do not repeat Ask Agent or destination headings inside the page', () => {
  const source = chatsPageSource();
  const side = sidePanelBlock(source);
  const detailPage = readFileSync(new URL('../src/pages/RightDetailRail.tsx', import.meta.url), 'utf8');

  assert.doesNotMatch(side, /pageEyebrow=|pageTitle=|Related tasks/, 'Ask Agent destinations should begin with their real content');
  assert.doesNotMatch(detailPage, /app-right-detail-page-header|app-right-detail-page-eyebrow|uppercase/, 'full-page destinations should not render repeated or capitalized hero copy');
});

test('shared Agent session pane and composer include transcript, attachments, forwarding, details, and right expansion hooks', () => {
  const source = chatsPageSource();
  const pane = chatSessionPaneBlock();

  for (const required of [
    'MessageBubble',
    'buildDesktopLiveTurnTranscriptMessage',
    'onStopActiveTurn',
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

test('thread panel keeps conversation reply but cannot open a nested thread', () => {
  const source = readFileSync(new URL('../src/pages/ChatsPage.tsx', import.meta.url), 'utf8');
  const threadPanel = blockBetween(source, '<ChatThreadPanel', '/>');

  assert.match(threadPanel, /onReplyMessage: handleReplyMessage/);
  assert.doesNotMatch(threadPanel, /onOpenMessageThread/);
});

test('side-panel Agent composer exposes the same visible attachment trigger and aligned composer controls as main chat', () => {
  const source = chatsPageSource();
  const side = sidePanelBlock(source);

  assert.match(source, /attachmentInputRef=\{session\.refs\.attachmentInput\}/, 'side-panel composer should receive its own attachment input ref');
  assert.match(side, /ref=\{attachmentInputRef\}/, 'side-panel file input should use the supplied side-panel ref, not a hidden unreachable input');
  assert.match(side, /<ComposerAttachmentAddMenu[\s\S]*inputRef=\{attachmentInputRef\}/, 'side-panel composer should expose the shared attachment add menu');
  assert.match(side, /<Plus\b/, 'shared attachment control should use a plus trigger');
  assert.match(side, /data-composer-attachment-add-menu="true"/, 'shared attachment control should expose an anchored menu');
  assert.match(side, /<span className="app-transient-action-label">Files and folders<\/span>/, 'attachment menu should expose the currently supported picker action');
  assert.match(side, /aria-label="Add attachment"/, 'side-panel attachment control should use the same accessible label as main composer');
  assert.match(side, /data-companion-attachment-control="true"/, 'side-panel attachment control should be identifiable for parity regression coverage');
  assert.match(side, /data-companion-composer-frame="true"[\s\S]*shrink-0 px-5 pb-4 pt-3/, 'side-panel composer should use the same outer frame spacing as the main composer so input blocks align');
  assert.match(side, /data-companion-send-row="true"[\s\S]*items-center justify-between gap-3 pt-2\.5/, 'side-panel composer controls should keep the same baseline rhythm while fitting narrow split panes');
  assert.doesNotMatch(side, /<span className="h-9 w-9 shrink-0" aria-hidden="true" \/>/, 'side-panel composer should not use a blank spacer instead of the real attachment controls');
});

test('side-panel Agent model controls use independent menu state and target the side session', () => {
  const source = chatsPageSource();
  const side = sidePanelBlock(source);

  assert.match(source, /openComposerSelector: ComposerSelector \| null/, 'side-panel model selector should own independent state');
  assert.match(source, /selector:\s*\{[\s\S]*toggle:/, 'side-panel model selector should expose its own toggle handler');
  assert.match(source, /const localConfigTargetSessionId = conversation[\s\S]*localAgentComposerConfigTargetSessionId\(conversation\)/, 'side-panel model controls should resolve the canonical runtime session when available');
  assert.match(source, /useCompanionComposerRuntime\(\{[\s\S]*sessionId: localConfigTargetSessionId/, 'side-panel model controls should hydrate the exact canonical runtime');
  assert.doesNotMatch(source, /companionComposerSelections\[[^\]]+\] \?\? composerSelection/, 'side-panel selection must not initialize from the main composer runtime');
  assert.match(source, /configTarget: localRuntime\.configTarget/, 'side-panel updates should use an isolated hydrated config target');
  assert.match(source, /selection: localRuntime\.selection/, 'side-panel model controls should receive their own selection');
  assert.match(side, /selection=\{localRouting\.selection\}/, 'side-panel model controls should render the supplied isolated selection');
  assert.match(source, /authLabel: localRuntime\.authLabel/, 'side-panel auth label should derive from the hydrated runtime provider');
  assert.match(source, /authOptions: localRuntime\.authOptions/, 'side-panel auth options should prioritize the hydrated runtime provider');
  assert.match(source, /openSelector: session\.selector\.value/, 'side-panel model controls should receive side-panel selector state');
  assert.match(source, /toggleSelector: session\.selector\.toggle/, 'side-panel model controls should receive the side-panel toggle handler');
  assert.match(side, /openSelector=\{openSelector\}/, 'side-panel model controls should read the isolated selector prop');
  assert.match(side, /onToggleSelector=\{toggleSelector\}/, 'side-panel model controls should toggle the isolated selector prop');
  assert.match(side, /selectComposerValue\(scope, type, value, localRouting\.configTarget\)/, 'side-panel model changes should target isolated side-panel state');
  assert.match(side, /selectComposerAuthChoice\(scope, providerId, choice, localRouting\.configTarget\)/, 'side-panel auth changes should target isolated side-panel state');
  assert.match(side, /selectComposerProviderChoice\(scope, option, localRouting\.configTarget\)/, 'side-panel provider changes should target isolated side-panel state');
  assert.doesNotMatch(side, /openSelector=\{openComposerSelector\}/, 'side-panel model controls must not share the main composer popover state');
});

test('side-panel cloud Agent model controls clone main bridge-routing menu behavior', () => {
  const source = chatsPageSource();
  const side = sidePanelBlock(source);
  const collaborationNavigationActions = collaborationNavigationActionsSource();

  assert.match(source, /const \[selectedMainAgentId, setSelectedMainAgentId\][\s\S]*const \[selectedCompanionAgentId, setSelectedCompanionAgentId\]/, 'side-panel bridge agent menu should not share main bridge routing selection');
  assert.match(source, /const companionAgents = useMemo\([\s\S]*companion\.host \? \[companion\.host\]/, 'side-panel bridge agent menu should derive routing agents for the companion session');
  assert.match(source, /enabled: presentation\.isCollaborationAgent[\s\S]*selectedAgent: routing\.selectedAgent/, 'side-panel cloud agents should receive the bridge-routing model branch');
  assert.match(source, /selection: routing\.selection/, 'side-panel cloud agent model controls should receive bridge routing selection');
  assert.match(side, /selection: collaborationRouting\.selection/, 'side-panel cloud agent model controls should pass the supplied bridge routing selection to the shared controls');
  assert.match(side, /selection=\{selection\}/, 'shared cloud agent model controls should render the supplied bridge routing selection');
  assert.match(side, /actions\.onUpdate\(\{[\s\S]*defaultModel: value/, 'side-panel cloud agent model changes should update bridge routing through the shared action');
  assert.match(side, /onSelectProviderChoice=\{\(_scope, option\) => \{[\s\S]*actions\.onUpdate/, 'side-panel cloud agent provider changes should update bridge routing through the shared action');
  assert.match(source, /targetSessionId: companion\.conversation\?\.canonicalSessionId[\s\S]*\?\? companion\.conversation\?\.id[\s\S]*\?\? null/, 'side-panel bridge routing should resolve the companion session id, not the active main session');
  assert.match(source, /applyUpdate\(\{[\s\S]*agent: companionAgent,[\s\S]*targetSessionId: companion\.conversation/, 'side-panel cloud route changes should pass the companion session id through the shared bridge routing updater');
  assert.match(source, /shared\.updateRouting\([\s\S]*routing\.fallbackAuthChoice,\s*targetSessionId,\s*\)/, 'the shared bridge routing updater should pass its target session through the bridge callback');
  assert.match(collaborationNavigationActions, /targetSessionIdOverride\?: string \| null/, 'cloud bridge route updater should accept an explicit target session override');
  assert.match(collaborationNavigationActions, /targetSessionIdOverride\?\.trim\(\)[\s\S]*\|\| activeConversation\.canonicalSessionId/, 'cloud bridge route updater should prefer the explicit side-panel session id before falling back to the active conversation');
  assert.doesNotMatch(side, /companionPaneKind === 'agent' && !companionConversationUsesCollaborationTransport[\s\S]*<ComposerModelControls/, 'side-panel model menu must not disappear for bridge-backed agent sessions');
});

test('split-pane Agent bottom controls stay compact without changing composer height during resize', () => {
  const source = chatsPageSource();
  const side = sidePanelBlock(source);
  const main = [
    '../src/pages/chatsPage.mainWorkspace.tsx',
    '../src/pages/chatsPage.mainComposer.tsx',
  ]
    .map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'))
    .join('\n');
  const composerSource = readFileSync(new URL('../src/kordi-app/components/composer.tsx', import.meta.url), 'utf8');

  assert.match(composerSource, /compact\?: boolean/, 'ComposerModelControls should expose a compact density for narrow panes');
  assert.match(side, /scrollClassName:\s*'app-chat-pane-transcript-scroll min-h-0 flex-1 overflow-x-hidden overscroll-contain'/, 'side-panel transcript should flex like the main pane while the shared split-pane inset keeps composer bottoms aligned during resize');
  assert.match(side, /data-companion-send-row="true"[\s\S]*flex-nowrap/, 'side-panel send row should stay single-line so resizing does not change composer height');
  assert.match(side, /data-companion-model-controls="true"[\s\S]*flex-nowrap/, 'side-panel model controls should stay single-line instead of wrapping under the input');
  assert.match(side, /<ComposerModelControls[\s\S]*compact=\{true\}/, 'side-panel model controls should use compact button widths');
  assert.match(main, /className=\{cn\([\s\S]*display\.showCompanionPane \? 'shrink gap-2' : 'shrink-0 gap-3'/, 'main split-pane composer controls should be allowed to shrink when a companion pane is open');
  assert.match(main, /<ComposerModelControls[\s\S]*compact=\{display\.showCompanionPane\}/, 'main split-pane model controls should also use compact widths');
  assert.match(composerSource, /compact \? 'w-\[5\.75rem\]' : 'w-\[8\.75rem\]'/, 'compact provider button width should be narrow enough for split panes');
});

test('split-pane Agent model selection menu escapes the right panel clipping boundary', () => {
  const composerSource = readFileSync(new URL('../src/kordi-app/components/composer.tsx', import.meta.url), 'utf8');
  const popoversSource = readFileSync(new URL('../src/styles/shell-popovers.css', import.meta.url), 'utf8');
  const themeTokensSource = readFileSync(new URL('../src/styles/theme-tokens.css', import.meta.url), 'utf8');
  const controlsStart = composerSource.indexOf('export function ComposerModelControls');
  assert.notEqual(controlsStart, -1, 'ComposerModelControls should exist');
  const controlsSource = composerSource.slice(controlsStart);

  assert.match(controlsSource, /getBoundingClientRect\(\)/, 'model selector should measure its trigger for viewport-aware placement');
  assert.match(controlsSource, /app-composer-model-menu-layer fixed/, 'model selector menu should be fixed-positioned so overflow-hidden panes do not clip it');
  assert.match(controlsSource, /createPortal\(renderSelectorMenu\(\), document\.body\)/, 'model selector menu should render through a body portal');
  assert.match(controlsSource, /const selectorMenuRef = useRef<HTMLDivElement \| null>\(null\)/, 'body-portaled selector should keep a ref for outside-click detection');
  assert.match(controlsSource, /document\.addEventListener\('pointerdown', handlePointerDown, true\)/, 'body-portaled selector should close when users click outside');
  assert.match(controlsSource, /document\.addEventListener\('keydown', handleKeyDown, true\)/, 'body-portaled selector should close when users press Escape');
  assert.match(controlsSource, /selectorMenuRef\.current\?\.contains\(target\)/, 'clicking inside the body-portaled selector should not close it');
  assert.match(popoversSource, /\.app-composer-model-menu-layer \{[\s\S]*--app-modal-bg:/, 'body-portaled selector should define its own dark theme variables');
  assert.match(popoversSource, /\.app-composer-model-menu-layer\.app-compact-model-menu-light \{[^}]*color-scheme:\s*light;/s, 'body-portaled selector should opt into light color controls');
  assert.match(popoversSource, /\.app-composer-model-menu-layer \.app-composer-popover-item,[\s\S]*background:\s*transparent;/, 'model selector options should stay flat against the popup surface');
  assert.match(popoversSource, /\.app-composer-model-menu-layer \.app-composer-popover-item:hover,[\s\S]*background:\s*var\(--app-transient-hover-bg\);/, 'flat model selector options should retain hover and keyboard feedback');
  assert.match(themeTokensSource, /\.app-compact-model-menu-light[^)]*\)\s*\{[\s\S]*--app-transient-surface-bg:/, 'body-portaled selector should inherit the portal-safe light surface variables');
  assert.doesNotMatch(controlsSource, /absolute bottom-full right-0 z-30 mb-2 max-h-\[min\(28rem,60vh\)\] w-\[340px\]/, 'model selector menu must not stay absolute inside the right-panel composer');
});

test('chat transcripts use measured virtualization instead of manual spacer windows', () => {
  const pane = chatSessionPaneBlock();
  const virtual = virtualTranscriptSource();

  assert.match(pane, /<VirtualTranscript/, 'main and side transcripts should render through the measured virtualizer');
  assert.match(virtual, /useVirtualizer\(\{/, 'the shared transcript should use TanStack virtualization');
  assert.match(virtual, /ref=\{virtualizer\.measureElement\}/, 'variable-height rows should be measured');
  assert.match(virtual, /overscan: TRANSCRIPT_WINDOW_OVERSCAN/, 'the mounted range should use bounded overscan');
  assert.doesNotMatch(pane, /data-transcript-window-spacer/, 'manual spacer nodes should be removed');
  assert.doesNotMatch(pane, /messages\.length > 0 \? messages\.map\(\(msg, idx\)/, 'ChatSessionPane must not render every message directly for long histories');
});

test('virtualized chat transcripts update their measured range while scrolling', () => {
  const virtual = virtualTranscriptSource();

  assert.match(virtual, /const virtualItems = virtualizer\.getVirtualItems\(\)/, 'visible rows should come from the virtualizer range');
  assert.match(virtual, /onScroll=\{handleScroll\}/, 'the shared transcript should preserve external scroll handling');
  assert.doesNotMatch(virtual, /transcriptWindowScrollAnchorIndex|transcriptMessageHeights/, 'scrolling should not run manual height summation');
});

test('virtualized chat transcripts reset by session identity even for equal-length sessions', () => {
  const source = chatsPageSource();
  const pane = chatSessionPaneBlock();
  const virtual = virtualTranscriptSource();

  assert.match(source, /sessionKey: activeConv\.id/, 'the main transcript should key resets by selected session');
  assert.match(source, /sessionKey: conversation\.id/, 'the side transcript should key resets by selected session');
  assert.match(pane, /sessionKey=\{sessionKey\}/, 'the shared pane should forward session identity');
  assert.match(virtual, /useLayoutEffect\([\s\S]*aligned\?\.sessionKey !== sessionKey/, 'tail alignment should happen in a layout effect keyed by session');
});

test('virtualized chat transcripts load and mount off-page jump targets', () => {
  const source = chatsPageSource();
  const pane = chatSessionPaneBlock();
  const virtual = virtualTranscriptSource();
  const navigation = virtualTranscriptNavigationSource();

  assert.match(source, /type TranscriptNavigationRequest/, 'jumps into windowed transcripts should use an explicit navigation request');
  assert.match(pane, /findNavigationIndex=\{\(entry, messageId\)/, 'ChatSessionPane should resolve jump targets against loaded messages');
  assert.match(
    navigation,
    /pendingTargetMounted[\s\S]*target\.classList\.contains\(TRANSCRIPT_NAVIGATION_HIGHLIGHT_CLASS\)[\s\S]*onNavigationHandled\?\.\(pendingRequest\)/,
    'the virtualizer should acknowledge only after the highlighted target commits',
  );
  assert.match(
    virtual,
    /virtualItem\.index === navigationTargetIndex[\s\S]*TRANSCRIPT_NAVIGATION_HIGHLIGHT_CLASS/,
    'the mounted virtual row should own the route-back highlight',
  );
  assert.match(virtual, /if \(!request \|\| pendingNavigationTargetIndex >= 0 \|\| !hasOlder \|\| !onLoadOlder\) return;/, 'already-loaded targets should not fetch older pages');
  assert.match(virtual, /void requestOlder\(signature\)/, 'missing targets should request older pages');
  assert.match(navigation, /scrollToIndex\(pendingTargetIndex\)/, 'found targets should move into the mounted range');
  assert.match(source, /setMainRequest\(\{[\s\S]*sessionKey: main\.conversation\.id,?[\s\S]*\}\)/, 'main navigation requests should retain their source session');
  assert.match(source, /setCompanionRequest\(\{[\s\S]*sessionKey: companion\.conversation\.id,?[\s\S]*\}\)/, 'companion navigation requests should retain their source session');
  assert.match(source, /onNavigationHandled: models\.navigation\.acknowledge/, 'main navigation should acknowledge the exact handled request');
  assert.match(source, /onNavigationHandled: navigation\.acknowledge/, 'companion navigation should acknowledge the exact handled request');
});

test('side-panel Agent session uses independent full-pane destination subtitles', () => {
  const source = chatsPageSource();
  const pane = chatSessionPaneBlock();
  const side = sidePanelBlock(source);

  assert.match(pane, /onOpenMessageDetail,/, 'ChatSessionPane should destructure onOpenMessageDetail');
  assert.match(pane, /onOpenMessageDetail=\{onOpenMessageDetail\}/, 'ChatSessionPane should pass message detail handling into MessageBubble');
  assert.doesNotMatch(side, /data-side-chat-session-detail-toggle="true"/, 'side-panel header should not show a session Details button');
  assert.doesNotMatch(side, /isCompanionDetailPanelCollapsed \? 'Details' : 'Hide details'/, 'side-panel header should not render Details/Hide details text');
  assert.match(source, /type CompanionDestinationState = \{[\s\S]*destination: ChatDestination;[\s\S]*activeArtifactId: string \| null;/, 'side-panel destinations should own a cohesive state separate from the main destination');
  assert.match(source, /function initialCompanionState\([\s\S]*destination: 'messages',[\s\S]*activeArtifactId: null/, 'side-panel destination state should reset by companion identity');
  assert.match(source, /destination=\{destinations\.activeDetailTab\}/, 'side-panel destination page should receive the side-panel detail tab');
  assert.match(source, /activeArtifactId=\{destinations\.activeArtifactId\}/, 'side-panel detail page should receive the side-panel artifact selection');
  assert.match(source, /activeDetailTab=\{destination\}/, 'side-panel detail rail should render using that isolated destination');
  assert.match(source, /scope="companion"/, 'side-panel header should expose the same destination subtitles');
  assert.match(source, /data-chat-destination-scope="companion"/, 'side-panel detail content should replace only its own pane');
  assert.match(source, /variant="page"/, 'side-panel detail content should use the whole-pane detail surface');
  assert.match(source, /destination === 'messages' \? \(/, 'side-panel transcript and detail destinations should be mutually exclusive inside the companion pane');
  assert.doesNotMatch(source, /companionInlineDetailRail|data-chat-companion-detail-rail/, 'side-panel details should no longer add another split column');
});

test('changing either main or Ask Agent session returns that pane to Messages before paint', () => {
  const source = chatsPageSource();

  assert.match(
    source,
    /useLayoutEffect\(\(\) => \{\s*setIsDetailPanelCollapsed\(true\);\s*}, \[conversationId, setIsDetailPanelCollapsed\]\);/,
    'every main session identity change should reset the main destination to Messages',
  );
  assert.match(
    source,
    /const activeCompanionState = companionState\.conversationId === companionKey[\s\S]*initialCompanionState\(companionKey\);[\s\S]*setCompanionState\(activeCompanionState\);/,
    'every Ask Agent session identity change should synchronously derive a Messages destination without stale selections',
  );
});

test('sending from main or side-panel chat schedules a jump to the sent message', () => {
  const source = chatsPageSource();
  const mainWorkspace = readFileSync(
    new URL('../src/pages/chatsPage.mainWorkspace.tsx', import.meta.url),
    'utf8',
  );
  const companionSession = readFileSync(
    new URL('../src/pages/useChatCompanionSession.ts', import.meta.url),
    'utf8',
  );

  assert.match(source, /scheduleTranscriptScrollToBottom/, 'ChatsPage workspaces should use the transcript bottom-scroll helper after sends');
  const mainSendStart = mainWorkspace.indexOf(
    'const handleSend = (draftOverride?: string, attachmentOverride?: AttachmentItem[]) => {',
  );
  const splitStart = mainWorkspace.indexOf('\n\n  return (', mainSendStart);
  assert.notEqual(mainSendStart, -1, 'main chat send handler should exist');
  assert.notEqual(splitStart, -1, 'main chat send block should have an end boundary');
  const mainSendBlock = mainWorkspace.slice(mainSendStart, splitStart);
  assert.match(mainSendBlock, /scheduleTranscriptScrollToBottom\(transcript\.chatTranscriptScrollRef\)/, 'main send should jump its own transcript to the new message');

  const sideSendStart = companionSession.indexOf('const sendDraft = (');
  const createSideStart = companionSession.indexOf('const setOpenComposerSelector', sideSendStart);
  assert.notEqual(sideSendStart, -1, 'side-panel send handler should exist');
  assert.notEqual(createSideStart, -1, 'side-panel send block should have an end boundary');
  const sideSendBlock = companionSession.slice(sideSendStart, createSideStart);
  assert.match(sideSendBlock, /scheduleTranscriptScrollToBottom\(transcriptScrollRef\)/, 'side-panel send should jump its own transcript to the new message');
});

test('queued Ask Agent bubbles expose icon-only edit and cancel actions before queued drafts flush', () => {
  const chatsSource = chatsPageSource();
  const queueSource = readFileSync(new URL('../src/features/chat/queuedDesktopMessages.ts', import.meta.url), 'utf8');
  const appModel = appModelSource();
  const queuedActions = queuedMessageActionsSource();
  const shellTypes = readFileSync(new URL('../src/app/kordiShellSlots.types.ts', import.meta.url), 'utf8');
  const shellBuilder = readFileSync(new URL('../src/app/mainContentShellBuilders.ts', import.meta.url), 'utf8');

  assert.match(queueSource, /removeQueuedDesktopMessageById/);
  assert.match(appModel, /handleCancelQueuedMessage/);
  assert.match(appModel, /handleEditQueuedMessage/);
  assert.match(queuedActions, /updateScopeDraft\([\s\S]*current,[\s\S]*'chat',[\s\S]*queuedMessage\.sessionId,[\s\S]*queuedMessage\.text/);
  assert.match(queuedActions, /removeQueuedDesktopMessageById\([\s\S]*current,[\s\S]*sessionId,[\s\S]*queuedMessageId/);
  const queuedBubble = queuedMessageSource();
  assert.match(chatsSource, /onCancelQueuedMessage/);
  assert.match(chatsSource, /onEditQueuedMessage/);
  assert.match(queuedBubble, /className="mt-0\.5 flex items-center gap-2"/);
  assert.match(queuedBubble, /app-queued-message-text[\s\S]*app-queued-message-actions/, 'queued action icons should align in the same row as the queued text');
  assert.match(queuedBubble, /aria-label=\{`Edit queued message/);
  assert.match(queuedBubble, /aria-label=\{`Cancel queued message/);
  assert.match(queuedBubble, /<SquarePen className="h-3\.5 w-3\.5" aria-hidden="true" \/>/);
  assert.match(queuedBubble, /<X className="h-3\.5 w-3\.5" aria-hidden="true" \/>/);
  assert.doesNotMatch(queuedBubble, />\s*(Edit|Cancel)\s*<\/button>/, 'queued actions should be icon-only, not visible text buttons');
  assert.match(shellTypes, /handleCancelQueuedMessage/);
  assert.match(shellTypes, /handleEditQueuedMessage/);
  assert.match(shellBuilder, /onCancelQueuedMessage: args\.handleCancelQueuedMessage/);
  assert.match(shellBuilder, /onEditQueuedMessage: args\.handleEditQueuedMessage/);
  assert.match(chatsSource, /onClick=\{\(\) => onEdit\?\.\(message\.sessionId, message\.id\)\}/);
  assert.match(chatsSource, /onClick=\{\(\) => onCancel\?\.\(message\.sessionId, message\.id\)\}/);
});

test('side-panel queued local-agent sends preserve draft visibility and reference context while a turn is running', () => {
  const chatsSource = chatsPageSource();
  const actionsSource = chatMessagesSource();
  const typesSource = messageTypesSource();

  const side = sidePanelBlock(chatsSource);
  assert.match(side, /queuedDesktopMessagesBySession\[conversation\.id\] \?\? \[\]/, 'side-panel transcript should render queued drafts for its own session');

  assert.match(typesSource, /contextMessages\?: DesktopChatContextMessage\[\]/, 'queued local messages should preserve optional side Agent reference context');

  const targetedStart = actionsSource.indexOf('const sendTargetedChatMessage = useCallback');
  const activeStart = actionsSource.indexOf('const handleSendChatMessage = useCallback', targetedStart);
  assert.notEqual(targetedStart, -1, 'targeted side-panel send path should exist');
  assert.notEqual(activeStart, -1, 'active send path should exist after targeted send path');
  const targetedSendBlock = actionsSource.slice(targetedStart, activeStart);
  assert.match(targetedSendBlock, /if \(delayReason === 'same-session-running'\) \{[\s\S]*queueLocalDraftForSession\(targetConversation\.id, text, attachments, contextMessages, activeChatQuote\)/, 'side-panel local sends should queue while the target session is running instead of showing the preparing error');
  assert.match(targetedSendBlock, /if \(delayReason === 'session-starting'\) \{\s*setDesktopChatError\(null\);\s*return;\s*\}/, 'side-panel duplicate sends should wait for the in-flight session without promoting normal preparation to an error');
  assert.doesNotMatch(targetedSendBlock, /Kordi is still preparing this session/, 'normal session preparation should not render through the sidebar-wide error channel');
  assert.match(actionsSource, /message\.runtimeRoute \?\? resolveChatRuntimeRoute\(message\.sessionId\)[\s\S]*message\.contextMessages \?\? \[\]/, 'flushing queued side messages should preserve the selected runtime route and reference context');
});

test('side-panel local-agent sends use the shared local send pipeline instead of duplicating optimistic persistence', () => {
  const source = chatMessagesSource();
  const targetedStart = source.indexOf('const sendTargetedChatMessage = useCallback');
  const activeStart = source.indexOf('const handleSendChatMessage = useCallback', targetedStart);
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

test('side-panel local-agent sends materialize an unhydrated runtime transcript before starting the turn', () => {
  const source = chatMessagesSource();
  const targetSource = readFileSync(
    new URL('../src/features/chat/messageActions/localAgentSessionTarget.ts', import.meta.url),
    'utf8',
  );
  const targetedStart = source.indexOf('const sendTargetedChatMessage = useCallback');
  const activeStart = source.indexOf('return useCallback', targetedStart);
  const targetedSendBlock = source.slice(targetedStart, activeStart);
  const sharedSendStart = source.indexOf('const sendLocalAgentChatMessage = useCallback');
  const sharedSendBlock = source.slice(sharedSendStart, targetedStart);
  const materializerStart = source.indexOf('const materializeLocalChatTarget = useCallback');
  const queuedSendStart = source.indexOf('const sendQueuedLocalMessage = useCallback', materializerStart);
  const materializerBlock = source.slice(materializerStart, queuedSendStart);
  const materializeIndex = sharedSendBlock.indexOf('await materializeTarget()');
  const sendIndex = sharedSendBlock.indexOf('await startDesktopChatMessage(');

  assert.match(targetedSendBlock, /materializeTarget: \(\) => materializeLocalChatTarget\(targetConversation\.id\)/, 'an inactive side Agent session should supply its runtime materializer');
  assert.notEqual(materializeIndex, -1, 'the shared send should await runtime transcript materialization');
  assert.notEqual(sendIndex, -1, 'the shared send should start the live turn');
  assert.ok(materializeIndex < sendIndex, 'runtime transcript materialization must finish before the live turn starts');
  assert.match(sharedSendBlock, /resolvedMaterializedState[\s\S]*appendOptimisticOutboundMessage/, 'the shared send should receive the materialized target state');
  assert.match(materializerBlock, /await fetchMaterializedLocalChatTarget\(sessionId, desktopChatState\)/, 'the action should use the shared target materializer');
  assert.match(targetSource, /await fetchDesktopChatState\(sessionId\)/, 'materialization should fetch the complete target runtime transcript');
  assert.match(targetSource, /materializedState\.activeSessionId !== sessionId[\s\S]*materializedState\.activeSession\.id !== sessionId/, 'materialization should fail closed if the runtime returns another session');
  assert.match(materializerBlock, /setDesktopChatState\(materializedState\)/, 'the panel should render from the hydrated runtime state during the turn');
});
