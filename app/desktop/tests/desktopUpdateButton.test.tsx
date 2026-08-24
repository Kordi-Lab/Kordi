import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { buildParticipantSpaces } from '../src/features/chat/participantSpaces';
import { desktopUpdateButtonPresentation, WorkspaceSidebar } from '../src/pages/WorkspaceSidebar';
import type { Conversation } from '../src/kordi-app/types';
import { readDesktopShellCss } from './helpers/readDesktopStyles';

function conversation(): Conversation {
  return {
    id: 'session:main',
    canonicalSessionId: 'session:main',
    name: 'Main',
    type: 'group',
    subtitle: 'hi',
    unread: 0,
    collaborationSources: [],
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
  const props = {
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
    activeCollaborationHost: null,
    localProfileAvatarSeed: 'me',
    isCollaborationSyncing: false,
    onRefreshBridge: () => {},
    onCopyBridgeHostUrl: () => {},
    onCreateBridgeDraft: () => {},
    ...overrides,
  };
  return {
    layout: props,
    chats: props,
    projects: props,
    directory: props,
    account: props,
  };
}

test('WorkspaceSidebar keeps the native updater hidden until an update is available', () => {
  const markup = renderToStaticMarkup(createElement(WorkspaceSidebar, sidebarProps({
    onCheckForUpdates: async () => ({ status: 'up-to-date', currentVersion: '0.0.1-beta.7' }),
  }) as never));

  assert.doesNotMatch(markup, /app-update-wave-button/);
  assert.doesNotMatch(markup, /Kordi update/);
});

test('WorkspaceSidebar places the updater in the global rail above the profile', () => {
  const markup = renderToStaticMarkup(createElement(WorkspaceSidebar, sidebarProps({
    onCheckForUpdates: async () => ({ status: 'up-to-date', currentVersion: '0.0.1-beta.7' }),
  }) as never));
  const source = [
    readFileSync(new URL('../src/pages/WorkspaceSidebar.tsx', import.meta.url), 'utf8'),
    readFileSync(new URL('../src/pages/workspaceSidebar.navigation.tsx', import.meta.url), 'utf8'),
    readFileSync(new URL('../src/pages/workspaceSidebar.update.tsx', import.meta.url), 'utf8'),
  ].join('\n');
  const css = readDesktopShellCss();
  const chatsHeaderStart = markup.indexOf('app-chat-sidebar-header');
  const chatsHeaderEnd = markup.indexOf('app-workspace-search', chatsHeaderStart);
  const chatsHeaderMarkup = markup.slice(chatsHeaderStart, chatsHeaderEnd);

  assert.match(markup, /class="app-chat-sidebar-header mb-2 flex items-center justify-between gap-2\.5"/);
  assert.match(markup, /class="app-chat-sidebar-actions flex shrink-0 items-center gap-2"/);
  assert.match(markup, /app-nav-rail-bottom/);
  assert.doesNotMatch(chatsHeaderMarkup, /app-update-wave-button/);
  assert.match(source, /<SidebarUpdater[\s\S]*<SidebarProfileControl/);
  assert.match(source, /app-update-wave-button app-workspace-nav-button relative mx-auto grid h-11 w-11 place-items-center rounded-\[14px\] p-0/);
  assert.match(source, /app-icon-button app-utility-button grid h-8 w-8 place-items-center rounded-\[10px\] p-0 transition/);
  assert.match(source, /src="\/blob-wave\.gif"/);
  assert.match(source, /srcSet="\/blob-wave-static\.png"/);
  assert.doesNotMatch(source, /border border-slate-300\/70 bg-white text-slate-950/);
  assert.doesNotMatch(css, /app-update-logo-button/);
  assert.match(css, /\.app-chat-sidebar-actions \.app-icon-button:focus-visible/);
});

test('WorkspaceSidebar does not expose the native updater control in web mode', () => {
  const markup = renderToStaticMarkup(createElement(WorkspaceSidebar, sidebarProps({
    isNativeShell: false,
    onCheckForUpdates: async () => ({ status: 'up-to-date', currentVersion: '0.0.1-beta.7' }),
  }) as never));

  assert.doesNotMatch(markup, /app-update-wave-button/);
  assert.doesNotMatch(markup, /Kordi update/);
});

test('desktop update button only presents actionable update states', () => {
  assert.deepEqual(desktopUpdateButtonPresentation({ status: 'checking' }), {
    visible: false,
    title: 'Kordi update needs attention',
  });
  assert.deepEqual(desktopUpdateButtonPresentation({
    status: 'available',
    currentVersion: '0.0.1-beta.7',
    latestVersion: '0.0.1-beta.8',
  }), {
    visible: true,
    title: 'Kordi 0.0.1-beta.8 is ready — open update options',
  });
  assert.equal(desktopUpdateButtonPresentation({ status: 'up-to-date' }).visible, false);
  assert.equal(desktopUpdateButtonPresentation({
    status: 'failed',
    failureStage: 'check',
  }).visible, false);
  assert.equal(desktopUpdateButtonPresentation({
    status: 'failed',
    failureStage: 'install',
  }).visible, true);
});

test('WorkspaceSidebar update affordance uses a friendly wave and confirmation popover', () => {
  const updaterSource = readFileSync(
    new URL('../src/pages/workspaceSidebar.update.tsx', import.meta.url),
    'utf8',
  );
  const source = [
    updaterSource,
    readFileSync(new URL('../src/pages/workspaceSidebar.updatePopover.tsx', import.meta.url), 'utf8'),
    readFileSync(new URL('../src/pages/workspaceSidebar.updatePresentation.ts', import.meta.url), 'utf8'),
  ].join('\n');

  assert.match(source, /blob-wave\.gif/);
  assert.match(source, /blob-wave-static\.png/);
  assert.match(source, /buttonPresentation\.visible/);
  assert.match(source, /void runUpdateCheck\(\)/);
  assert.match(source, /className="sr-only" role="status"/);
  assert.doesNotMatch(source, /Check for updates/);
  assert.match(source, /w-\[14\.5rem\]/);
  assert.match(source, /w-\[12\.75rem\]/);
  assert.match(source, /app-update-popover-tail/);
  assert.match(source, /app-update-popover/);
  assert.match(source, /data-update-state=\{state\.status\}/);
  assert.doesNotMatch(source, /app-update-popover overflow-hidden border/);
  assert.match(source, /w-\[18rem\]/);
  assert.match(source, /title=\{isUpdateConfirmOpen \? undefined : buttonPresentation\.title\}/);
  assert.doesNotMatch(source, /min-h-16 items-center justify-center/);
  assert.doesNotMatch(source, />\s*Done\s*</);
  assert.match(source, /status === 'up-to-date'/);
  assert.match(source, /Kordi is up to date/);
  assert.match(source, /Couldn’t check for updates/);
  assert.match(source, /state\.status === 'available'/);
  assert.match(source, /New Kordi is here/);
  assert.match(source, /aria-label=\{state\.status === 'available' \? 'Update Kordi now' : undefined\}/);
  assert.doesNotMatch(source, />\s*Update now\s*</);
  assert.doesNotMatch(source, />\s*Not now\s*</);
  assert.match(source, /onInstallUpdate/);
  assert.match(source, /Downloading/);
  assert.match(source, /Installing verified update…/);
  assert.doesNotMatch(source, /Installing signed update/);
  assert.match(source, /Relaunching/);
  assert.match(source, /Unable to install the verified update\./);
  assert.doesNotMatch(source, /download, verify, install, and relaunch Kordi automatically\./);
  assert.match(source, /Retry/);
  assert.match(source, /Download manually/);
  assert.match(source, /receivedBytes/);
  assert.match(source, /totalBytes/);
  assert.match(source, /role="progressbar"/);
  assert.match(source, /aria-valuenow/);
  assert.match(source, /app-update-popover-action-primary/);
  assert.match(source, /app-update-popover-action-secondary/);
  assert.match(source, /updateConfirmAnchor/);
  assert.match(source, /Math\.min\(rect\.right \+ 8/);
  assert.match(source, /bottom: Math\.max\(12, window\.innerHeight - rect\.bottom\)/);
  assert.match(source, /position: 'fixed'/);
  assert.match(source, /bottom: anchor\.bottom/);
  assert.match(source, /if \(!anchor \|\| typeof document === 'undefined'\) return null/);
  assert.doesNotMatch(updaterSource, /RefreshCw/);
});

test('desktop update popover uses a quiet theme-aware surface in dark mode', () => {
  const css = readDesktopShellCss();
  const updateSurface = css.match(/\.kordi-app \.app-popover\.app-update-popover \{([\s\S]*?)\n\}/)?.[1] ?? '';

  assert.match(updateSurface, /--app-update-surface: var\(--app-transient-surface-bg\)/);
  assert.match(updateSurface, /--app-update-edge: var\(--app-transient-border\)/);
  assert.match(updateSurface, /--app-update-shadow: var\(--app-transient-shadow\)/);
  assert.match(updateSurface, /border: 1px solid var\(--app-update-edge\) !important/);
  assert.match(updateSurface, /box-shadow: var\(--app-update-shadow\) !important/);
  assert.doesNotMatch(updateSurface, /var\(--app-shadow-float\)/);
  assert.doesNotMatch(updateSurface, /inset 0 1px 0/);
  assert.match(css, /\.kordi-app\.theme-light \.app-popover\.app-update-popover/);
  assert.match(css, /\.app-update-popover-status-danger/);
  assert.match(css, /\.app-update-popover-action:focus-visible/);
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
