// Login-free preview of the left rail count badges with sample counts.
//   ?theme=light|dark
import './previewChatTheme';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';

import type { CloudAccount } from '../../src/features/cloud/authClient';
import { settingsSections, type SettingsSectionId } from '../../src/kordi-app/data/settings';
import type { NavId, ThemeMode } from '../../src/kordi-app/types';
import type { CloudAccountSettingsTabId } from '../../src/pages/CloudAccountSettingsDialog';
import { WorkspaceNavigationRail } from '../../src/pages/workspaceSidebar.navigation';
import type { WorkspaceSidebarAccount } from '../../src/pages/workspaceSidebar.types';

const theme = new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark';
document.body.classList.add(`theme-${theme}`);
document.documentElement.style.colorScheme = theme;

const noop = () => {};
const resolved = async () => {};
const account: CloudAccount = {
  accountId: 'acct_rail_preview', displayName: 'Taylor Preview', primaryEmail: 'taylor@example.test',
  primaryEmailVerified: true, nodeId: 'node-rail-preview', passwordSet: false,
  kordiId: '517309264', accountNumber: '517309264', kordiIdChangeAvailableAt: null,
  about: '', location: null, timeZone: null, website: null, birthday: null, avatarUrl: null,
  avatar: { entityType: 'human', entityId: 'acct_rail_preview', source: 'generated', style: 'lorelei', seed: 'rail-preview', rendererVersion: 'dicebear-rust-10.6.0-styles-10.5.0', uploadedAsset: null, version: 1, updatedAt: '2026-10-01T00:00:00Z' },
};

/** Unread chats, unread agent chats, and contact requests for each sample rail. */
const SAMPLES = [
  { label: 'One each', chats: 1, agents: 1, requests: 1 },
  { label: 'A few', chats: 3, agents: 7, requests: 2 },
  { label: 'Over nine', chats: 12, agents: 40, requests: 10 },
];

function Rail({ chats, agents, requests }: { chats: number; agents: number; requests: number }) {
  const [activeNav, setActiveNav] = useState<NavId>('chats');
  const [tab, setTab] = useState<CloudAccountSettingsTabId | null>(null);
  const [section, setSection] = useState<SettingsSectionId>('auth');
  const [themeMode, setThemeMode] = useState<ThemeMode>(theme);
  const sidebarAccount: WorkspaceSidebarAccount = {
    cloudAccount: account, cloudAccountDialogTab: tab, setCloudAccountDialogTab: setTab,
    onUpdateCloudProfile: resolved,
    cloudSettings: {
      settingsSections, activeSettingsSectionId: section, setActiveSettingsSectionId: setSection,
      authSettingsLayoutWidth: 620, isNativeShell: true, desktopAuthState: { authPath: '', hasAnyAuth: false, providers: [] },
      isDesktopAuthLoading: false, desktopAuthError: null, activeLoginProviderId: null,
      selectAuthProvider: noop, openLoginFlow: noop, refreshDesktopAuth: resolved,
      handleSelectAuthChoice: resolved, handleRemoveAuthProfile: resolved, handleLogoutProvider: resolved,
      themeMode, setThemeMode,
    },
  };
  return (
    <WorkspaceNavigationRail
      isNativeShell={false}
      activeNav={activeNav}
      setActiveNav={setActiveNav}
      agentUnread={agents}
      contactUnread={chats}
      pendingContactRequestCount={requests}
      account={sidebarAccount}
      updater={{}}
      onOpenSession={noop}
    />
  );
}

function Preview() {
  return (
    <div className={`kordi-app theme-${theme} app-cloud-workspace-surface`} style={{ display: 'flex', gap: 40, height: '100dvh', padding: '0 24px', background: 'var(--app-page-bg)' }}>
      {SAMPLES.map((sample) => (
        <aside key={sample.label} data-sample={sample.label} className="app-side-shell app-workspace-sidebar overflow-hidden" style={{ height: 360 }}>
          <div className="flex h-full">
            <Rail chats={sample.chats} agents={sample.agents} requests={sample.requests} />
          </div>
        </aside>
      ))}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Preview />);
