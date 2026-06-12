import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ChatsPage } from '../src/pages/ChatsPage';
import type { Conversation } from '../src/kordi-app/types';

const activeConv: Conversation = {
  id: 'session:one',
  canonicalSessionId: 'session:one',
  name: 'Alice',
  type: 'person',
  subtitle: 'Direct chat',
  unread: 0,
  bridges: ['Cloud'],
  trust: 'Owned',
  directness: 'Direct chat',
  participants: ['Alice'],
  messages: [{ id: 'msg:alice', role: 'person', sender: 'Alice', senderType: 'human', text: 'Can we ship?', time: '10:42' }],
};

function renderChatsPage(overrides: Record<string, unknown> = {}) {
  return renderToStaticMarkup(createElement(ChatsPage, {
    isNativeShell: false,
    showChatDetailRail: false,
    collapseChatSessions: false,
    setIsSessionPanelCollapsed: () => undefined,
    showRightDetailRail: false,
    isDetailPanelCollapsed: true,
    setIsDetailPanelCollapsed: () => undefined,
    activeConv,
    activeConversationIsBridge: false,
    activeBridgeModelHost: null,
    desktopChatState: null,
    cloudSelfAgentSyncStatus: null,
    onUpdateBridgeAgentModelRouting: async () => undefined,
    isEditingDesktopSessionTitle: false,
    setIsEditingDesktopSessionTitle: () => undefined,
    desktopSessionRenameDraft: '',
    setDesktopSessionRenameDraft: () => undefined,
    onRenameDesktopSession: async () => undefined,
    chatTranscriptScrollRef: { current: null },
    onTranscriptScroll: () => undefined,
    onOpenSource: () => undefined,
    onOpenArtifact: () => undefined,
    desktopLiveTurn: null,
    queuedDesktopMessages: [],
    filteredChatSlashCommands: [],
    filteredChatMentionTargets: [],
    chatSlashMenuIndex: 0,
    setChatSlashMenuIndex: () => undefined,
    acceptChatSlashCommand: () => undefined,
    acceptChatMentionTarget: () => undefined,
    chatAttachmentInputRef: { current: null },
    chatComposerAttachments: [],
    saveDesktopAttachments: async () => [],
    saveDesktopAttachmentPaths: async () => [],
    removeChatComposerAttachment: () => undefined,
    chatComposerText: '',
    updateChatComposerDraft: () => undefined,
    setChatComposerText: () => undefined,
    composerControlsRef: { current: null },
    activeRuntimeContextStatus: null,
    activeRuntimeCacheText: null,
    composerSelection: { mode: 'Send as Me', model: 'GPT-5.4', thinking: 'xhigh' },
    openComposerSelector: null,
    toggleComposerSelector: () => undefined,
    selectComposerValue: () => undefined,
    composerAuthLabel: 'Connected',
    composerAuthOptions: [],
    selectComposerAuthChoice: () => undefined,
    selectComposerProviderChoice: () => undefined,
    composerProviderOptions: [],
    chatModelOptions: [],
    isDesktopChatSending: false,
    onStopDesktopChatTurn: () => undefined,
    onStopBridgeAgentRequest: () => undefined,
    onRequestBridgeContact: () => undefined,
    onForkChatMessage: async () => undefined,
    onSelectSession: () => undefined,
    onSendChatMessage: () => undefined,
    hasAnyAuth: true,
    onOpenAuthSettings: () => undefined,
    onOpenAccountAuthentication: () => undefined,
    ...overrides,
  } as any));
}

test('chat page renders message selection action bar', () => {
  const markup = renderChatsPage({
    messageSelectionMode: true,
    selectedMessageCount: 2,
    selectedMessageIds: new Set(['msg:alice']),
    isMessageSelectable: () => true,
    onSelectMessage: () => undefined,
    onToggleSelectedMessage: () => undefined,
    onCancelMessageSelection: () => undefined,
    onCopySelectedMessages: () => undefined,
    onForwardSelectedMessages: () => undefined,
  });

  assert.match(markup, /data-message-selection-bar="true"/);
  assert.match(markup, /2 selected/);
  assert.match(markup, /Copy/);
  assert.match(markup, /Forward/);
  assert.match(markup, /Cancel/);
});

test('group chat transcript hides fork button, fork chips, and group fork source UI', () => {
  const groupConv: Conversation = {
    ...activeConv,
    id: 'session:group:weather',
    canonicalSessionId: 'session:group:weather',
    name: 'Weather group',
    type: 'person',
    subtitle: 'Group chat',
    participants: ['Me', 'Alice', 'Bob'],
    messages: [{
      id: 'msg:group-agent',
      entryId: 'msg:group-agent-entry',
      role: 'owned-agent',
      sender: 'My Kordi',
      senderType: 'agent',
      text: 'Here is the group answer.',
      time: '10:50',
    }],
  };
  const markup = renderChatsPage({
    activeConv: groupConv,
    desktopChatState: {
      sessions: [
        { id: 'session:group:weather', title: 'Weather group' },
        { id: 'session:fork:group-weather', title: 'Old group fork', forkedFromSessionId: 'session:group:weather', forkedFromMessageId: 'msg:group-agent-entry', updatedAtLabel: '10:55' },
      ],
    },
  });

  assert.doesNotMatch(markup, /app-message-fork-button/);
  assert.doesNotMatch(markup, /app-message-fork-chip/);
  assert.doesNotMatch(markup, /Old group fork/);
});

test('group-derived fork transcript hides fork source backlink and snapshot divider', () => {
  const groupForkConv: Conversation = {
    ...activeConv,
    id: 'session:fork:group-weather',
    canonicalSessionId: 'session:fork:group-weather',
    name: 'Old group fork',
    forkedFromSessionId: 'session:group:weather',
    forkedFromMessageId: 'msg:group-agent-entry',
    messages: [{
      id: 'msg:group-agent',
      entryId: 'msg:group-agent-entry',
      role: 'owned-agent',
      sender: 'My Kordi',
      senderType: 'agent',
      text: 'Inherited group answer.',
      time: '10:50',
      isForkSnapshot: true,
    }],
  };
  const markup = renderChatsPage({
    activeConv: groupForkConv,
    desktopChatState: {
      sessions: [
        { id: 'session:group:weather', title: 'Weather group' },
        { id: 'session:fork:group-weather', title: 'Old group fork', forkedFromSessionId: 'session:group:weather', forkedFromMessageId: 'msg:group-agent-entry' },
      ],
    },
  });

  assert.doesNotMatch(markup, /Forked from Weather group/);
  assert.doesNotMatch(markup, /Forked from conversation/);
});

test('chat composer renders active quote preview with remove control', () => {
  const markup = renderChatsPage({
    activeChatQuote: {
      action: 'quote',
      source: {
        sourceSessionId: 'session:one',
        sourceMessageId: 'msg:alice',
        senderLabel: 'Alice',
        textPreview: 'Can we ship?',
        attachmentCount: 0,
        createdAtMs: null,
        timeLabel: '10:42',
      },
    },
    onClearChatQuote: () => undefined,
  });

  assert.match(markup, /data-composer-quote-preview="true"/);
  assert.match(markup, /Alice/);
  assert.match(markup, /Can we ship/);
  assert.match(markup, /aria-label="Remove quoted message"/);
});
