import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const chatsPageSource = () => readFileSync(new URL('../src/pages/ChatsPage.tsx', import.meta.url), 'utf8');
const chatMessagesSource = () => readFileSync(new URL('../src/features/chat/messageActions/chatMessages.ts', import.meta.url), 'utf8');

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
  assert.match(side, /data-companion-send-row="true"[\s\S]*items-center justify-between gap-4 pt-2\.5/, 'side-panel composer controls should use the same baseline row spacing as main composer');
  assert.doesNotMatch(side, /<span className="h-9 w-9 shrink-0" aria-hidden="true" \/>/, 'side-panel composer should not use a blank spacer instead of the real attachment controls');
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
