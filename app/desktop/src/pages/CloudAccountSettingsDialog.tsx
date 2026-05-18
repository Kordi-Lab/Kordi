import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { createPortal } from 'react-dom';
import { KeyRound, Palette, User, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { AuthPage } from '@/kordi-app/auth/AuthPage';
import { SettingsValueControl } from '@/kordi-app/components';
import { IdentityAvatar } from '@/kordi-app/components/IdentityAvatar';
import { fileToAvatarDataUrl } from '@/kordi-app/components/avatarOverrides';
import type { SettingsSection, SettingsSectionId } from '@/kordi-app/data/settings';
import type { DesktopAuthProvider, DesktopAuthState, ThemeMode } from '@/kordi-app/types';
import type { CloudAccount, CloudProfileUpdateInput } from '@/features/cloud/authClient';
import { cloudAvatarImageUrl, cloudAvatarSeedForAccount } from '@/features/cloud/avatar';
import { cn } from '@/lib/utils';

type CloudAccountSettingsTabId = 'profile' | 'auth' | 'appearance';

export type CloudAccountSettingsConfig = {
  settingsSections: SettingsSection[];
  activeSettingsSectionId: SettingsSectionId;
  setActiveSettingsSectionId: Dispatch<SetStateAction<SettingsSectionId>>;
  authSettingsLayoutWidth: number;
  isNativeShell: boolean;
  desktopAuthState: DesktopAuthState | null;
  isDesktopAuthLoading: boolean;
  desktopAuthError: string | null;
  activeLoginProviderId: string | null;
  selectAuthProvider: (providerId: string) => void;
  openLoginFlow: (provider: DesktopAuthProvider, mode: 'oauth' | 'api-key', options?: { authority?: string; requireAuthority?: boolean }) => void;
  refreshDesktopAuth: () => Promise<void>;
  handleSelectAuthChoice: (providerId: string, choice: string) => Promise<void>;
  handleRemoveAuthProfile: (providerId: string, profileId: string) => Promise<void>;
  handleLogoutProvider: (providerId: string) => Promise<void>;
  themeMode: ThemeMode;
  setThemeMode: Dispatch<SetStateAction<ThemeMode>>;
};

type CloudAccountSettingsDialogProps = CloudAccountSettingsConfig & {
  isOpen: boolean;
  account: CloudAccount | null;
  localProfileAvatarSeed?: string | null;
  onClose: () => void;
  onUpdateProfile: (input: CloudProfileUpdateInput) => Promise<void>;
  onSignOut?: () => Promise<void> | void;
};

function profileDisplayName(account: CloudAccount | null) {
  return account?.displayName?.trim() || account?.primaryEmail?.trim() || 'Cloud profile';
}

function cloudProfileRows(account: CloudAccount | null) {
  if (!account) return [];
  return [
    account.primaryEmail?.trim() ? { label: 'Email', value: account.primaryEmail.trim() } : null,
    { label: 'Account ID', value: account.accountId },
  ].filter((row): row is { label: string; value: string } => Boolean(row));
}

export function CloudAccountSettingsDialog({
  isOpen,
  account,
  localProfileAvatarSeed,
  onClose,
  onUpdateProfile,
  onSignOut,
  settingsSections,
  activeSettingsSectionId,
  setActiveSettingsSectionId,
  authSettingsLayoutWidth,
  isNativeShell,
  desktopAuthState,
  isDesktopAuthLoading,
  desktopAuthError,
  activeLoginProviderId,
  selectAuthProvider,
  openLoginFlow,
  refreshDesktopAuth,
  handleSelectAuthChoice,
  handleRemoveAuthProfile,
  handleLogoutProvider,
  themeMode,
  setThemeMode,
}: CloudAccountSettingsDialogProps) {
  const [activeTab, setActiveTab] = useState<CloudAccountSettingsTabId>('profile');
  const [displayNameDraft, setDisplayNameDraft] = useState('');
  const [avatarUrlDraft, setAvatarUrlDraft] = useState('');
  const [profileError, setProfileError] = useState('');
  const [isSavingProfile, setIsSavingProfile] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setDisplayNameDraft(account?.displayName?.trim() || '');
    setAvatarUrlDraft(cloudAvatarImageUrl(account?.avatarUrl) || '');
    setProfileError('');
    setIsSavingProfile(false);
    setIsSigningOut(false);
  }, [account, isOpen]);

  useEffect(() => {
    if (!isOpen || typeof window === 'undefined') return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen || !account || typeof document === 'undefined') return null;

  const displayName = profileDisplayName(account);
  const avatarSeed = cloudAvatarSeedForAccount(account.accountId, account.avatarUrl) || localProfileAvatarSeed || account.accountId;
  const appearanceSection = settingsSections.find((section) => section.id === 'appearance');
  const tabs: Array<{ id: CloudAccountSettingsTabId; label: string; icon: typeof User }> = [
    { id: 'profile', label: 'Profile', icon: User },
    { id: 'auth', label: 'Authentication', icon: KeyRound },
    { id: 'appearance', label: 'Theme', icon: Palette },
  ];

  const selectTab = (tabId: CloudAccountSettingsTabId) => {
    setActiveTab(tabId);
    if (tabId === 'auth' || tabId === 'appearance') {
      setActiveSettingsSectionId(tabId);
    }
  };

  const saveProfile = async () => {
    if (isSavingProfile) return;
    const nextDisplayName = displayNameDraft.trim();
    if (!nextDisplayName) {
      setProfileError('Enter a display name.');
      return;
    }
    try {
      setIsSavingProfile(true);
      setProfileError('');
      await onUpdateProfile({
        displayName: nextDisplayName,
        avatarUrl: avatarUrlDraft.trim() || undefined,
      });
    } catch (caught) {
      setProfileError(caught instanceof Error ? caught.message : 'Could not save profile.');
    } finally {
      setIsSavingProfile(false);
    }
  };

  const handleAvatarFile = (file: File | undefined) => {
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      setProfileError('Choose a PNG, JPEG, or WebP image.');
      return;
    }
    void fileToAvatarDataUrl(file)
      .then((dataUrl) => {
        setAvatarUrlDraft(dataUrl);
        setProfileError('');
      })
      .catch((caught) => setProfileError(caught instanceof Error ? caught.message : 'Could not use that image.'));
  };

  const signOut = async () => {
    if (!onSignOut || isSigningOut) return;
    try {
      setIsSigningOut(true);
      setProfileError('');
      await onSignOut();
      onClose();
    } catch (caught) {
      setProfileError(caught instanceof Error ? caught.message : 'Could not sign out.');
      setIsSigningOut(false);
    }
  };

  const profilePanel = (
    <div className="grid gap-4">
      <div className="app-surface-muted rounded-[24px] p-5">
        <div className="flex flex-wrap items-center gap-4">
          <IdentityAvatar
            kind="human"
            seed={avatarSeed}
            name={displayNameDraft || displayName}
            imageUrl={avatarUrlDraft || undefined}
            className="h-16 w-16 border border-white/10"
          />
          <div className="min-w-0 flex-1">
            <div className="text-[17px] font-semibold tracking-tight text-white">Profile</div>
            <div className="mt-1 max-w-[38rem] text-[13px] leading-5 text-slate-400">
              Update the name and avatar other Cloud users see in contacts, shared chats, and participant lists.
            </div>
          </div>
          <Button type="button" variant="secondary" className="h-9 rounded-full px-4 text-[12px]" onClick={() => fileInputRef.current?.click()}>
            Upload avatar
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="sr-only"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = '';
              handleAvatarFile(file);
            }}
          />
        </div>
      </div>

      <div className="app-surface-muted rounded-[24px] p-5">
        <label className="grid gap-2 text-[12px] font-medium text-slate-300">
          Display name
          <input
            value={displayNameDraft}
            onChange={(event) => setDisplayNameDraft(event.currentTarget.value)}
            className="app-input-shell h-10 rounded-[14px] px-3 text-[13px] text-white outline-none"
            placeholder="Your display name"
          />
        </label>
        {profileError ? <div className="mt-3 text-[12px] text-rose-200">{profileError}</div> : null}
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <div className="grid gap-1 text-[11px] text-slate-500">
            {cloudProfileRows(account).map((row) => (
              <div key={row.label}><span className="text-slate-400">{row.label}:</span> {row.value}</div>
            ))}
          </div>
          <div className="flex items-center gap-2">
            {onSignOut ? (
              <Button type="button" variant="secondary" className="h-9 rounded-full px-4 text-[12px]" disabled={isSigningOut} onClick={signOut}>
                {isSigningOut ? 'Signing out…' : 'Sign out'}
              </Button>
            ) : null}
            <Button type="button" className="h-9 rounded-full px-4 text-[12px]" disabled={isSavingProfile} onClick={saveProfile}>
              {isSavingProfile ? 'Saving…' : 'Save profile'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );

  const authPanel = (
    <AuthPage
      variant="settings"
      layoutWidth={Math.min(authSettingsLayoutWidth, 720)}
      isNativeShell={isNativeShell}
      authState={desktopAuthState}
      isLoading={isDesktopAuthLoading}
      error={desktopAuthError}
      selectedProviderId={activeLoginProviderId}
      onSelectProvider={selectAuthProvider}
      onOpenLogin={openLoginFlow}
      onRefresh={() => { void refreshDesktopAuth(); }}
      onSelectAuthChoice={(providerId, choice) => { void handleSelectAuthChoice(providerId, choice); }}
      onRemoveAuthProfile={(providerId, profileId) => { void handleRemoveAuthProfile(providerId, profileId); }}
      onLogoutProvider={(providerId) => { void handleLogoutProvider(providerId); }}
    />
  );

  const themePanel = (
    <div className="app-surface-muted overflow-hidden rounded-[24px]">
      {(appearanceSection?.items ?? []).map((item, index) => (
        <div
          key={item.label}
          className={cn(
            'grid items-center gap-3 px-5 py-4 md:grid-cols-[minmax(0,1fr)_minmax(208px,280px)]',
            index > 0 && 'border-t border-white/10',
          )}
        >
          <div>
            <div className="text-[13px] font-medium text-white">{item.label}</div>
            <div className="mt-1 text-[12px] leading-5 text-slate-400">{item.hint}</div>
          </div>
          <div className="flex justify-end">
            <SettingsValueControl item={item} themeMode={themeMode} onSelectThemeMode={setThemeMode} />
          </div>
        </div>
      ))}
    </div>
  );

  return createPortal(
    <div
      className="fixed inset-0 z-[180] flex items-center justify-center bg-black/45 px-6 py-6 backdrop-blur-md"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-label="Account settings"
        aria-modal="true"
        className="app-modal-panel grid h-[min(720px,calc(100vh-48px))] w-[min(920px,calc(100vw-48px))] overflow-hidden rounded-[30px] border border-white/10 bg-[linear-gradient(150deg,rgba(126,111,64,0.10),rgba(15,16,18,0.22)_46%,rgba(10,11,13,0.28))] text-white shadow-[var(--app-shadow-float)] md:grid-cols-[220px_minmax(0,1fr)]"
      >
        <div className="flex min-h-0 flex-col border-r border-white/10 p-4">
          <div className="mb-4 flex items-center gap-3">
            <IdentityAvatar kind="human" seed={avatarSeed} name={displayName} imageUrl={cloudAvatarImageUrl(account.avatarUrl)} className="h-10 w-10 border border-white/10" />
            <div className="min-w-0">
              <div className="truncate text-[13px] font-semibold text-white">{displayName}</div>
              <div className="truncate text-[11px] text-slate-400">Cloud account</div>
            </div>
          </div>
          <div className="grid gap-1">
            {tabs.map((tab) => {
              const Icon = tab.icon;
              const active = activeTab === tab.id || (tab.id !== 'profile' && activeSettingsSectionId === tab.id && activeTab === tab.id);
              return (
                <button
                  key={tab.id}
                  type="button"
                  className={cn(
                    'flex items-center gap-2.5 rounded-[14px] px-3 py-2 text-left text-[13px] font-medium transition',
                    active ? 'app-list-item-active text-white' : 'app-list-item text-slate-300 hover:text-white',
                  )}
                  onClick={() => selectTab(tab.id)}
                >
                  <Icon className="h-4 w-4" />
                  {tab.label}
                </button>
              );
            })}
          </div>
        </div>
        <div className="flex min-h-0 flex-col p-5">
          <div className="mb-4 flex shrink-0 items-start justify-between gap-3">
            <div>
              <div className="text-[18px] font-semibold tracking-tight text-white">
                {activeTab === 'profile' ? 'Profile' : activeTab === 'auth' ? 'Authentication' : 'Theme'}
              </div>
              <div className="mt-1 max-w-[42rem] text-[12px] leading-5 text-slate-400">
                {activeTab === 'profile'
                  ? 'Manage the Cloud identity shown to you and your contacts.'
                  : activeTab === 'auth'
                    ? 'Connect model providers and manage saved access.'
                    : 'Adjust the interface palette.'}
              </div>
            </div>
            <button type="button" className="grid h-9 w-9 place-items-center rounded-full text-slate-300 transition hover:bg-white/10 hover:text-white" onClick={onClose} aria-label="Close account settings">
              <X className="h-4 w-4" />
            </button>
          </div>
          <ScrollArea className="min-h-0 flex-1 pr-2">
            {activeTab === 'profile' ? profilePanel : activeTab === 'auth' ? authPanel : themePanel}
          </ScrollArea>
        </div>
      </div>
    </div>,
    document.querySelector('.bridge-app') ?? document.body,
  );
}
