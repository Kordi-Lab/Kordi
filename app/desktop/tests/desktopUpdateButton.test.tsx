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

test('WorkspaceSidebar renders an icon-only blue Kordi logo update button in the Chats header', () => {
  const markup = renderToStaticMarkup(createElement(WorkspaceSidebar, sidebarProps({
    onCheckForUpdates: async () => ({ status: 'updateAvailable', latestVersion: '99.0.0', installCommand: 'Install fake release' }),
  }) as never));

  assert.match(markup, /aria-label="Check for Kordi updates"/);
  assert.match(markup, /app-update-logo-button/);
  assert.match(markup, /src="\/favicon\.svg"/);
  assert.doesNotMatch(markup, /<span>Update<\/span>/);
});

test('desktop update button is wired through the Tauri command surface', () => {
  const desktopSource = readFileSync(new URL('../src/lib/desktop.ts', import.meta.url), 'utf8');
  const tauriSource = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
  const sidebarSource = readFileSync(new URL('../src/app/assembleSidebarSlot.tsx', import.meta.url), 'utf8');

  assert.match(desktopSource, /desktop_check_for_updates/);
  assert.match(tauriSource, /desktop_check_for_updates/);
  assert.match(sidebarSource, /checkDesktopForUpdates/);
});
