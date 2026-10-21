// Login-free synthetic preview of the real account settings dialog opened on
// the Profile tab. Saves stay in this page, so it makes no network calls and
// needs no session.
//   ?theme=light|dark
//   ?state=normal|locked|taken
//     normal: Save resolves after 400 ms and the sample account takes the draft.
//     locked: the Kordi ID changes again one year from now.
//     taken:  Save fails with kordi_id_taken, as the real client reports it.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';

import type { CloudAccount, CloudProfileUpdateInput } from '../../src/features/cloud/authClient';
import { buildCloudAuthError } from '../../src/features/cloud/cloudAuthError';
import { settingsSections, type SettingsSectionId } from '../../src/kordi-app/data/settings';
import type { ThemeMode } from '../../src/kordi-app/types';
import { CloudAccountSettingsDialog } from '../../src/pages/CloudAccountSettingsDialog';

const params = new URLSearchParams(window.location.search);
const requestedTheme = params.get('theme');
const requestedState = params.get('state');
const state: 'normal' | 'locked' | 'taken' = requestedState === 'locked' || requestedState === 'taken' ? requestedState : 'normal';
const prefersLight = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: light)').matches;
const theme: 'light' | 'dark' = requestedTheme === 'light' || requestedTheme === 'dark'
  ? requestedTheme
  : prefersLight ? 'light' : 'dark';
const isNativeShell = '__TAURI_INTERNALS__' in window;

// Match the body classes the app shell sets for the resolved theme.
document.body.classList.toggle('theme-light', theme === 'light');
document.body.classList.toggle('theme-dark', theme === 'dark');
document.documentElement.style.colorScheme = theme;

const oneYearAhead = new Date();
oneYearAhead.setFullYear(oneYearAhead.getFullYear() + 1);

const initialAccount: CloudAccount = {
  accountId: 'acct_profile_preview',
  kordiId: '517309264',
  accountNumber: '517309264',
  kordiIdChangeAvailableAt: state === 'locked' ? oneYearAhead.toISOString() : null,
  displayName: 'Taylor Preview',
  primaryEmail: 'taylor@profile.example',
  primaryEmailVerified: true,
  about: 'Design and research at a small studio.',
  location: 'Lisbon',
  timeZone: 'Europe/Lisbon',
  website: null,
  birthday: '1996-03-04',
  avatarUrl: null,
  avatar: {
    entityType: 'human',
    entityId: 'acct_profile_preview',
    source: 'generated',
    style: 'lorelei',
    seed: 'profile_preview_seed',
    rendererVersion: 'dicebear-rust-10.6.0-styles-10.5.0',
    uploadedAsset: null,
    version: 1,
    updatedAt: '2026-10-01T00:00:00Z',
  },
  nodeId: 'node-profile-preview',
  passwordSet: false,
};

const noop = () => undefined;
const resolved = async () => undefined;
const wait = (ms: number) => new Promise((resolve) => { window.setTimeout(resolve, ms); });

/** Applies a PATCH /me body the way the server echoes it back. */
function applyProfileUpdate(account: CloudAccount, input: CloudProfileUpdateInput): CloudAccount {
  const optional = (value: string | undefined, current: string | null | undefined) => (
    value === undefined ? current ?? null : value.trim() || null
  );
  return {
    ...account,
    displayName: input.displayName?.trim() || account.displayName,
    kordiId: input.kordiId === undefined ? account.kordiId : input.kordiId.trim() || account.accountNumber || account.kordiId,
    about: optional(input.about, account.about),
    location: optional(input.location, account.location),
    timeZone: optional(input.timeZone, account.timeZone),
    website: optional(input.website, account.website),
    birthday: optional(input.birthday, account.birthday),
  };
}

function Preview() {
  const [account, setAccount] = useState(initialAccount);
  const [activeSettingsSectionId, setActiveSettingsSectionId] = useState<SettingsSectionId>('appearance');
  const [themeMode, setThemeMode] = useState<ThemeMode>(requestedTheme === 'light' || requestedTheme === 'dark' ? requestedTheme : 'auto');

  const updateProfile = async (input: CloudProfileUpdateInput) => {
    await wait(400);
    if (state === 'taken') {
      throw buildCloudAuthError(409, { errorCode: 'kordi_id_taken', message: 'That Kordi ID is already taken.' }, 'Could not update profile.');
    }
    setAccount((current) => applyProfileUpdate(current, input));
  };

  const link = (query: string, label: string) => <a href={`?${query}`} className="underline">{label}</a>;

  return (
    <div className={`kordi-app theme-${theme} min-h-screen`} style={{ background: 'var(--utility-background)', color: 'var(--utility-foreground)' }}>
      <aside
        className="fixed inset-x-0 top-0 z-[200] flex items-center justify-between gap-4 border-b border-white/10 px-6 py-2 text-[12px] text-slate-400"
        style={{ background: 'var(--utility-background)' }}
      >
        <span>Synthetic preview · Real Profile settings with a sample account</span>
        <span className="flex gap-3">
          {link(`theme=light&state=${state}`, 'Light')}
          {link(`theme=dark&state=${state}`, 'Dark')}
          {link(`theme=${theme}&state=normal`, 'Normal')}
          {link(`theme=${theme}&state=locked`, 'Locked')}
          {link(`theme=${theme}&state=taken`, 'Taken')}
        </span>
      </aside>
      <CloudAccountSettingsDialog
        isOpen
        initialTab="profile"
        account={account}
        // The preview is the dialog, so closing keeps it open.
        onClose={noop}
        onUpdateProfile={updateProfile}
        connectorsClient={null}
        memoryClient={null}
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
