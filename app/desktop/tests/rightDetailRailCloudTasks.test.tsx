import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { assembleRightDetailSlot } from '../src/app/assembleRightDetailSlot';
import type { RightDetailShellArgs } from '../src/app/kordiShellSlots.types';

function baseArgs(overrides: Partial<RightDetailShellArgs> = {}): RightDetailShellArgs {
  return {
    isNativeShell: true,
    activeNav: 'chats',
    activeDetailTab: 'info',
    setActiveDetailTab: () => {},
    setIsDetailPanelCollapsed: () => {},
    activeSourcePreview: null,
    setActiveSourcePreview: () => {},
    activeArtifactId: null,
    setActiveArtifactId: () => {},
    activeChatArtifacts: [],
    activeProjectArtifacts: [],
    activeProject: {
      id: 'project:one', name: 'Project', summary: '', bridge: 'Local', scope: '/tmp', status: 'Local',
      people: [], agents: [], pendingInvites: [], artifacts: 0, tasks: 0, root: '/tmp', sessions: [],
    },
    activeProjectSession: {
      id: 'session:project:one', name: 'Project chat', summary: '', lastActive: '--:--', status: 'Active',
      participants: [], artifacts: 0, tasks: 0, messages: [],
    },
    activeProjectLastMessage: undefined,
    activeProjectCollaborationHost: null,
    activeProjectCollaborationProject: null,
    isProjectBridgeBusy: false,
    bridgeInvite: null,
    handleCreateProjectBridgeInvite: async () => {},
    setActiveNav: () => {},
    setActiveConvId: () => {},
    getStatusBadgeClass: () => 'app-badge-neutral',
    desktopLiveTurn: null,
    activeConv: {
      id: 'session:group:cloud-one',
      canonicalSessionId: 'session:group:cloud-one',
      name: 'Cloud group',
      type: 'person',
      subtitle: 'session:group:cloud-one',
      unread: 0,
      collaborationSources: ['Cloud'],
      trust: 'Cloud',
      directness: 'Group chat',
      participants: ['Me'],
      messages: [],
      taskActivities: [],
    },
    activeConvHasSubtitle: true,
    activeLastMessage: undefined,
    activeConversationUsesCollaboration: true,
    activeCollaborationConversationHost: null,
    activeCollaborationConversation: null,
    activeCollaborationAwaitingReply: false,
    isCollaborationSyncing: false,
    lastCollaborationSyncAtLabel: null,
    activeSessionProject: null,
    activeQueuedDesktopMessages: [],
    chatTranscriptScrollRef: { current: null },
    ...overrides,
  };
}

test('chat detail panel hides internal delivery metadata from normal user surfaces', () => {
  const source = readFileSync(new URL('../src/pages/ChatDetailPanel.tsx', import.meta.url), 'utf8');

  assert.doesNotMatch(source, /app-detail-kicker">Delivery/);
  assert.doesNotMatch(source, /app-detail-kicker">Delivery context/);
  assert.doesNotMatch(source, /label="Host"/);
  assert.doesNotMatch(source, /label="Peer node"/);
  assert.doesNotMatch(source, /label="Runtime"/);
  assert.doesNotMatch(source, /activeCollaborationConversationHostNodeId \|\| 'desktop node'/);
  assert.doesNotMatch(source, /activeConv\.collaborationSources\.join/);
});

test('hosted chat destination contract includes icon tabs and renders one full page', () => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      __KORDI_BOOTSTRAP__: { edition: 'cloud', title: 'Kordi Cloud' },
      location: { search: '?edition=cloud' },
      localStorage: null,
    },
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { title: 'Kordi Cloud' },
  });

  const infoMarkup = renderToStaticMarkup(createElement(() => assembleRightDetailSlot(baseArgs())));
  const tasksMarkup = renderToStaticMarkup(createElement(() => assembleRightDetailSlot(baseArgs({ activeDetailTab: 'tasks' }))));
  const chatsPage = readFileSync(new URL('../src/pages/ChatsPage.tsx', import.meta.url), 'utf8');

  assert.match(infoMarkup, /app-right-detail-page/);
  assert.match(infoMarkup, /Info/);
  assert.doesNotMatch(infoMarkup, /app-detail-tab-list/);
  assert.match(tasksMarkup, /Tasks/);
  assert.match(chatsPage, /\{ id: 'messages', label: 'Messages', icon: MessageSquare \}/);
  assert.match(chatsPage, /\{ id: 'info', label: 'Info', icon: Info \}/);
  assert.match(chatsPage, /\{ id: 'artifacts', label: 'Artifacts', icon: FolderOpen \}/);
  assert.match(chatsPage, /\{ id: 'tasks', label: 'Tasks', icon: CheckCircle2 \}/);
});

test('inspector lists do not draw a trailing row divider under panel list content', () => {
  const shellCss = readFileSync(new URL('../src/styles/shell.css', import.meta.url), 'utf8');

  assert.match(
    shellCss,
    /\.app-inspector-list\s*>\s*:last-child\s*{[^}]*border-bottom:\s*0\s*;[^}]*}/s,
  );
});

test('inspector meta lists do not double up with following section dividers', () => {
  const shellCss = readFileSync(new URL('../src/styles/shell.css', import.meta.url), 'utf8');

  assert.match(
    shellCss,
    /\.app-inspector-meta-list\s*>\s*:last-child\s*{[^}]*border-bottom:\s*0\s*;[^}]*}/s,
  );
});

test('right rail detail sheets do not keep a glass filter edge under empty Tasks content', () => {
  const shellCss = readFileSync(new URL('../src/styles/shell.css', import.meta.url), 'utf8');

  assert.match(
    shellCss,
    /\.app-right-detail-rail\s+\.app-detail-sheet\s*{[^}]*backdrop-filter:\s*none\s*;[^}]*-webkit-backdrop-filter:\s*none\s*;[^}]*}/s,
  );
});

test('right rail does not inherit main panel shadows or transparency that create light-theme seams', () => {
  const shellCss = readFileSync(new URL('../src/styles/shell.css', import.meta.url), 'utf8');
  const themeOverridesCss = readFileSync(new URL('../src/styles/theme-overrides.css', import.meta.url), 'utf8');

  assert.match(
    shellCss,
    /\.app-right-detail-rail\s*{[^}]*background:\s*var\(--app-main-bg\)\s*;[^}]*box-shadow:\s*none\s*;[^}]*}/s,
  );
  assert.match(
    shellCss,
    /\.app-right-detail-rail\.app-main-panel\s*{[^}]*backdrop-filter:\s*none\s*;[^}]*-webkit-backdrop-filter:\s*none\s*;[^}]*}/s,
  );
  assert.match(
    themeOverridesCss,
    /\.kordi-app\.theme-light\s+\.app-right-detail-rail\s*{[^}]*box-shadow:\s*none\s*;[^}]*}/s,
  );
});
