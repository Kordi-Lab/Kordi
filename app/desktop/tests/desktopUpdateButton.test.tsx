import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { buildParticipantSpaces } from '../src/features/chat/participantSpaces';
import { WorkspaceSidebar } from '../src/pages/WorkspaceSidebar';
import type { Conversation } from '../src/kordi-app/types';

function conversation(): Conversation {
  return {
    id: 'session:main',
    canonicalSessionId: 'session:main',
    name: 'Main',
    type: 'group',
    subtitle: 'hi',
    unread: 0,
    bridges: [],
    trust: 'Cloud',
    directness: 'Group',
    participants: ['Me'],
    messages: [{ role: 'person', sender: 'Me', text: 'hi', time: '09:00' }],
    updatedAtLabel: '09:00',
  };
}

function sidebarProps(overrides: Record<string, unknown> = {}) {
  const chatConversations = [conversation()];
  const participantSpaces = buildParticipantSpaces(chatConversations);
  return {
    isNativeShell: true,
    isSingleWorkspacePage: false,
    collapseChatSessions: false,
    showSessionRail: true,
    sessionRailWidth: 248,
    activeNav: 'chats',
    setActiveNav: () => {},
    chatConversations,
    onCreateChatSession: () => {},
    chatSearch: '',
    setChatSearch: () => {},
    isDesktopChatLoading: false,
    desktopChatError: null,
    filteredConversations: chatConversations,
    participantSpaces,
    contactParticipantSpaces: participantSpaces,
    agentParticipantSpaces: [],
    activeConvId: 'session:main',
    onSelectChatSession: () => {},
    onStartChatWithPerson: () => {},
    onStartChatWithAgent: () => {},
    onCreateChatGroup: () => {},
    onAddContactByNodeId: () => {},
    onCreateChatSessionInParticipantSpace: () => {},
    onRenameChatGroup: () => {},
    onAddChatGroupMembers: () => {},
    onRemoveChatGroupMember: () => {},
    onSetChatGroupAdmin: () => {},
    onDeleteChatSession: () => {},
    onMoveChatSessionToProject: () => {},
    onCreateProjectFromFolder: () => {},
    onCreateProject: () => {},
    runtimeProjects: [],
    projectSearch: '',
    setProjectSearch: () => {},
    filteredProjects: [],
    activeProjectId: '',
    activeProjectSessionId: '',
    projectSelectedSessionIds: {},
    selectProject: () => {},
    expandedProjectIds: {},
    setExpandedProjectIds: () => {},
    onSelectProjectSession: () => {},
    groupedContacts: [],
    displayedContacts: [],
    addableContacts: [],
    contactRequestCount: 0,
    setActiveContactGroup: () => {},
    setActiveContactId: () => {},
    displayedAgents: [],
    activeBridgeHost: null,
    localProfileAvatarSeed: 'me',
    isBridgePolling: false,
    onRefreshBridge: () => {},
    onCopyBridgeHostUrl: () => {},
    onCreateBridgeDraft: () => {},
    ...overrides,
  };
}

test('WorkspaceSidebar hides the update button until an available release is detected', () => {
  const markup = renderToStaticMarkup(createElement(WorkspaceSidebar, sidebarProps({
    onCheckForUpdates: async () => ({ status: 'available', latestVersion: '99.0.0', notes: 'Signed update' }),
  }) as never));

  assert.doesNotMatch(markup, /app-update-logo-button/);
  assert.doesNotMatch(markup, /src="\/favicon\.svg"/);
  assert.doesNotMatch(markup, /<span>Update<\/span>/);
});

test('WorkspaceSidebar update affordance uses a refresh logo and confirmation popover', () => {
  const source = readFileSync(new URL('../src/pages/WorkspaceSidebar.tsx', import.meta.url), 'utf8');

  assert.match(source, /RefreshCw/);
  assert.match(source, /app-update-logo-button/);
  assert.match(source, /updateState\.status === 'available'/);
  assert.match(source, /Update available/);
  assert.match(source, /Update now/);
  assert.match(source, /Not now/);
  assert.match(source, /onInstallUpdate/);
  assert.match(source, /Downloading/);
  assert.match(source, /Installing verified update…/);
  assert.doesNotMatch(source, /Installing signed update/);
  assert.match(source, /Relaunching/);
  assert.match(source, /Unable to install the verified update\./);
  assert.match(source, /download, verify, install, and relaunch Kordi automatically\./);
  assert.match(source, /Retry/);
  assert.match(source, /Download manually/);
  assert.match(source, /receivedBytes/);
  assert.match(source, /totalBytes/);
  assert.match(source, /updateConfirmAnchor/);
  assert.match(source, /position: 'fixed'/);
  assert.match(source, /isUpdateConfirmOpen && updateConfirmAnchor && typeof document !== 'undefined' \? createPortal/);
  assert.doesNotMatch(source, /src="\/favicon\.svg"/);
});

test('desktop update button is wired through the signed updater controller', () => {
  const desktopSource = readFileSync(new URL('../src/lib/desktop.ts', import.meta.url), 'utf8');
  const tauriSource = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
  const sidebarSource = readFileSync(new URL('../src/app/assembleSidebarSlot.tsx', import.meta.url), 'utf8');

  assert.match(desktopSource, /desktopUpdaterController/);
  assert.match(tauriSource, /tauri_plugin_updater/);
  assert.match(tauriSource, /tauri_plugin_process/);
  assert.match(sidebarSource, /checkDesktopForUpdates/);
  assert.match(sidebarSource, /installDesktopUpdate/);
  assert.match(sidebarSource, /subscribeDesktopUpdater/);
});
