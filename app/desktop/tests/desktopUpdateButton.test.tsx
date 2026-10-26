import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import React, { act, createElement, useState } from 'react';
import { useSidebarUpdater, type SidebarUpdaterProps } from '../src/pages/workspaceSidebar.update';
import type { DesktopUpdaterState } from '../src/features/updates/desktopUpdater';
import { withJsdomRoot } from './helpers/mountWithJsdom';
import { HelpEntry } from '../src/features/onboarding/HelpEntry';
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

test('WorkspaceSidebar exposes updates through Help without a separate rail button', () => {
  const markup = renderToStaticMarkup(createElement(WorkspaceSidebar, sidebarProps({
    onCheckForUpdates: async () => ({ status: 'up-to-date' }),
  }) as never));
  const navigation = readFileSync(new URL('../src/pages/workspaceSidebar.navigation.tsx', import.meta.url), 'utf8');
  const help = readFileSync(new URL('../src/features/onboarding/HelpMenu.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(markup, /app-update-wave-button|blob-wave/);
  assert.match(navigation, /<HelpEntry\s+updateAction=\{menuAction\}/);
  assert.ok(help.indexOf('{updateAction ?') > help.indexOf('Contact support'));
  for (const updateAvailable of [false, true]) {
    const helpMarkup = renderToStaticMarkup(<HelpEntry activeNav="chats" setActiveNav={() => {}}
      account={{ localProfileAvatarSeed: 'preview' }} onOpenSession={() => {}}
      updateAction={{ updateAvailable, label: updateAvailable ? 'Update available' : 'Check for updates', onClick: () => {} }} />);
    assert.equal(helpMarkup.includes('bg-red-500'), updateAvailable);
    assert.equal(helpMarkup.includes('Help &amp; setup: update available'), updateAvailable);
  }
});

test('the Help update row describes checking, availability, progress, and retry states', () => {
  const labels: [DesktopUpdaterState, string][] = [
    [{ status: 'idle' }, 'Check for updates'],
    [{ status: 'up-to-date' }, 'Check for updates'],
    [{ status: 'checking' }, 'Checking for updates…'],
    [{ status: 'available', latestVersion: '1.2.3' }, 'Update available'],
    [{ status: 'downloading' }, 'Downloading update…'],
    [{ status: 'installing' }, 'Installing update…'],
    [{ status: 'relaunching' }, 'Relaunching Kordi…'],
    [{ status: 'failed', failureStage: 'check' }, 'Check for updates'],
    [{ status: 'failed', failureStage: 'install' }, 'Retry update'],
  ];
  for (const [state, title] of labels) {
    assert.equal(desktopUpdateButtonPresentation(state).title, title);
  }
});

function UpdateHarness(props: SidebarUpdaterProps) {
  const { menuAction, popover } = useSidebarUpdater(props);
  const [open, setOpen] = useState(false);
  return <>
    <button onClick={() => setOpen(true)}>Help</button>
    {open && menuAction ? <button data-update-action onClick={(event) => {
      menuAction.onClick(event);
      setOpen(false);
    }}>{menuAction.label}</button> : null}
    {popover}
  </>;
}

async function clickButton(label: string) {
  const button = Array.from(document.querySelectorAll('button')).find((item) =>
    item.getAttribute('aria-label') === label || item.textContent === label);
  assert.ok(button, `Missing button: ${label}`);
  await act(async () => button.click());
}

test('Help checks manually and keeps the update dialog alive after the menu closes', async () => {
  await withJsdomRoot(async (mount) => {
    let checks = 0;
    let installs = 0;
    let publish: (state: DesktopUpdaterState) => void = () => {};
    await mount(<UpdateHarness isNativeShell onCheckForUpdates={async () => {
      checks += 1;
      return checks === 1 ? { status: 'up-to-date' } : { status: 'available', latestVersion: '1.2.3' };
    }} onInstallUpdate={async () => { installs += 1; }} onSubscribeToUpdate={(listener) => {
      publish = listener;
      return () => {};
    }} />);
    assert.equal(checks, 1);
    assert.equal(document.querySelector('[role="dialog"]'), null);
    await clickButton('Help');
    await clickButton('Check for updates');
    assert.equal(checks, 2);
    assert.equal(installs, 0);
    assert.equal(document.querySelector('[data-update-action]'), null);
    assert.equal(document.querySelector('[role="dialog"]')?.getAttribute('data-update-state'), 'available');
    await clickButton('Close update status');
    await clickButton('Help');
    await clickButton('Update available');
    assert.equal(checks, 2);
    await clickButton('Update Kordi now');
    assert.equal(installs, 1);
    await act(async () => publish({ status: 'downloading', receivedBytes: 50, totalBytes: 100 }));
    assert.equal(document.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow'), '50');
  });
});

test('failed manual checks retry checking without invoking installation', async () => {
  await withJsdomRoot(async (mount) => {
    let checks = 0;
    let installs = 0;
    await mount(<UpdateHarness isNativeShell onCheckForUpdates={async () => {
      checks += 1;
      if (checks < 3) throw new Error('Offline');
      return { status: 'up-to-date' };
    }} onInstallUpdate={async () => { installs += 1; }} />);
    await clickButton('Help');
    await clickButton('Check for updates');
    assert.equal(document.querySelector('[role="dialog"]')?.getAttribute('data-update-state'), 'failed');
    await clickButton('Try again');
    assert.equal(checks, 3);
    assert.equal(installs, 0);
    assert.match(document.body.textContent ?? '', /Kordi is up to date/);
  });
});

test('web mode omits the native update row and does not check', async () => {
  await withJsdomRoot(async (mount) => {
    let checks = 0;
    await mount(<UpdateHarness isNativeShell={false} onCheckForUpdates={async () => {
      checks += 1;
      return { status: 'up-to-date' };
    }} />);
    await clickButton('Help');
    assert.equal(document.querySelector('[data-update-action]'), null);
    assert.equal(checks, 0);
  });
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
  assert.match(tauriSource, /desktop_relaunch_after_update/);
  assert.match(sidebarSource, /checkDesktopForUpdates/);
  assert.match(sidebarSource, /installDesktopUpdate/);
  assert.match(sidebarSource, /subscribeDesktopUpdater/);
});
