// Login-free synthetic preview of the real account settings dialog opened on
// the Memory tab. It uses the in-memory preview memory client, so it
// makes no network calls and needs no session. The sample memories cover every
// label layer: categories, Grounding cards (one, several, Every card, none),
// and origins (Global, chats, projects, a group).
import { useState } from 'react';
import { createRoot } from 'react-dom/client';

import type { CloudAccount } from '../../src/features/cloud/authClient';
import { publishMemoryVersion } from '../../src/features/memory/memoryAvailability';
import { createPreviewMemoryClient } from '../../src/features/memory/memoryClient';
import { createPreviewMemoryImporter } from '../../src/features/memory/memoryImportClient';
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
  accountId: 'acct_memory_preview',
  kordiId: '517309264',
  displayName: 'Taylor Preview',
  primaryEmail: 'taylor@memory.example',
  about: 'Design and research at a small studio.',
  location: 'Lisbon',
  timeZone: 'Europe/Lisbon',
  website: null,
  birthday: '1996-03-04',
  avatarUrl: null,
  avatar: {
    entityType: 'human',
    entityId: 'acct_memory_preview',
    source: 'generated',
    style: 'lorelei',
    seed: 'memory_preview_seed',
    rendererVersion: 'dicebear-rust-10.6.0-styles-10.5.0',
    uploadedAsset: null,
    version: 1,
    updatedAt: '2026-10-01T00:00:00Z',
  },
  nodeId: 'node-memory-preview',
  passwordSet: false,
};

// `?memoryVersion=2` previews a server without several cards per memory.
const requestedVersion = Number(new URLSearchParams(window.location.search).get('memoryVersion') ?? '3');
publishMemoryVersion(Number.isFinite(requestedVersion) && requestedVersion > 0 ? requestedVersion : 3);

const memoryClient = createPreviewMemoryClient({ accountLabel: account.primaryEmail ?? 'taylor@memory.example' });
const memoryImporter = createPreviewMemoryImporter();
// A signed-in provider, so the Import section is ready to run.
const desktopAuthState = { authPath: '', hasAnyAuth: true, providers: [] };
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
        <span>Synthetic preview · Real Memory settings components with sample data synced to a sample account</span>
        <span className="flex gap-3">
          <a href="?theme=light" className="underline">Light</a>
          <a href="?theme=dark" className="underline">Dark</a>
        </span>
      </aside>
      <CloudAccountSettingsDialog
        isOpen
        initialTab="memory"
        account={account}
        // The preview is the dialog, so closing keeps it open.
        onClose={noop}
        onUpdateProfile={resolved}
        memoryClient={memoryClient}
        memoryImporter={memoryImporter}
        settingsSections={settingsSections}
        activeSettingsSectionId={activeSettingsSectionId}
        setActiveSettingsSectionId={setActiveSettingsSectionId}
        authSettingsLayoutWidth={620}
        isNativeShell={isNativeShell}
        desktopAuthState={desktopAuthState}
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
