// Login-free synthetic preview of the real account settings dialog opened on
// the Connectors tab. It uses the in-memory preview connectors client, so it
// makes no network calls and needs no session.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';

import type { CloudAccount } from '../../src/features/cloud/authClient';
import { createPreviewConnectorsClient } from '../../src/features/connectors/connectorsClient';
import { settingsSections, type SettingsSectionId } from '../../src/kordi-app/data/settings';
import type { ThemeMode } from '../../src/kordi-app/types';
import { CloudAccountSettingsDialog } from '../../src/pages/CloudAccountSettingsDialog';

const requestedTheme = new URLSearchParams(window.location.search).get('theme');
const prefersLight = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: light)').matches;
const theme: 'light' | 'dark' = requestedTheme === 'light' || requestedTheme === 'dark'
  ? requestedTheme
  : prefersLight ? 'light' : 'dark';
const isNativeShell = '__TAURI_INTERNALS__' in window;

// Match the body classes the app shell sets for the resolved theme.
document.body.classList.toggle('theme-light', theme === 'light');
document.body.classList.toggle('theme-dark', theme === 'dark');
document.documentElement.style.colorScheme = theme;

const account: CloudAccount = {
  accountId: 'acct_connectors_preview',
  kordiId: '482731906',
  displayName: 'Taylor Preview',
  primaryEmail: 'taylor@connectors.example',
  avatarUrl: null,
  avatar: {
    entityType: 'human',
    entityId: 'acct_connectors_preview',
    source: 'generated',
    style: 'lorelei',
    seed: 'connectors_preview_seed',
    rendererVersion: 'dicebear-rust-10.6.0-styles-10.5.0',
    uploadedAsset: null,
    version: 1,
    updatedAt: '2026-10-01T00:00:00Z',
  },
  nodeId: 'node-connectors-preview',
  passwordSet: false,
};

const connectorsClient = createPreviewConnectorsClient();
const noop = () => undefined;
const resolved = async () => undefined;

function Preview() {
  const [activeSettingsSectionId, setActiveSettingsSectionId] = useState<SettingsSectionId>('auth');
  const [themeMode, setThemeMode] = useState<ThemeMode>(requestedTheme === 'light' || requestedTheme === 'dark' ? requestedTheme : 'auto');

  return (
    <div className={`kordi-app theme-${theme} min-h-screen`} style={{ background: 'var(--utility-background)', color: 'var(--utility-foreground)' }}>
      <aside
        className="fixed inset-x-0 top-0 z-[200] flex items-center justify-between gap-4 border-b border-white/10 px-6 py-2 text-[12px] text-slate-400"
        style={{ background: 'var(--utility-background)' }}
      >
        <span>Synthetic preview · Real Connectors settings components with sample data</span>
        <span className="flex gap-3">
          <a href="?theme=light" className="underline">Light</a>
          <a href="?theme=dark" className="underline">Dark</a>
        </span>
      </aside>
      <CloudAccountSettingsDialog
        isOpen
        initialTab="connectors"
        account={account}
        // The preview is the dialog, so closing keeps it open.
        onClose={noop}
        onUpdateProfile={resolved}
        connectorsClient={connectorsClient}
        connectorsIsPreview
        settingsSections={settingsSections}
        activeSettingsSectionId={activeSettingsSectionId}
        setActiveSettingsSectionId={setActiveSettingsSectionId}
        authSettingsLayoutWidth={620}
        isNativeShell={isNativeShell}
        desktopAuthState={null}
        isDesktopAuthLoading={false}
        desktopAuthError={null}
        activeLoginProviderId={null}
        selectAuthProvider={noop}
        openLoginFlow={noop}
        refreshDesktopAuth={resolved}
        handleSelectAuthChoice={resolved}
        handleRemoveAuthProfile={resolved}
        handleLogoutProvider={resolved}
        themeMode={themeMode}
        setThemeMode={setThemeMode}
      />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Preview />);
