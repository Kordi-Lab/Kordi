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

export type CloudAccountSettingsTabId = 'profile' | 'auth' | 'appearance';

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
  initialTab?: CloudAccountSettingsTabId;
  account: CloudAccount | null;
  localProfileAvatarSeed?: string | null;
  onClose: () => void;
  onUpdateProfile: (input: CloudProfileUpdateInput) => Promise<void>;
  onSignOut?: () => Promise<void> | void;
};

function profileDisplayName(account: CloudAccount | null) {
  return account?.displayName?.trim() || account?.primaryEmail?.trim() || 'Profile';
}

function cloudProfileRows(account: CloudAccount | null) {
  if (!account) return [];
  return [
    account.primaryEmail?.trim() ? { label: 'Email', value: account.primaryEmail.trim() } : null,
    { label: 'Account ID', value: account.accountId },
  ].filter((row): row is { label: string; value: string } => Boolean(row));
}

export function cloudProfileSaveInput({
  displayNameDraft,
  avatarUrlDraft,
  originalAvatarUrl,
}: {
  displayNameDraft: string;
  avatarUrlDraft: string;
  originalAvatarUrl: string;
}): CloudProfileUpdateInput {
  const input: CloudProfileUpdateInput = { displayName: displayNameDraft.trim() };
  const nextAvatarUrl = avatarUrlDraft.trim();
  if (nextAvatarUrl && nextAvatarUrl !== originalAvatarUrl.trim()) {
    input.avatarUrl = nextAvatarUrl;
  }
  return input;
}

export function CloudAccountSettingsDialog({
  isOpen,
  initialTab = 'profile',
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
  const openedAccountIdRef = useRef<string | null>(null);
  const wasOpenRef = useRef(false);
  const originalAvatarUrlRef = useRef('');

  useEffect(() => {
    if (!isOpen) {
      wasOpenRef.current = false;
      openedAccountIdRef.current = null;
      return;
    }
    const accountId = account?.accountId ?? null;
    if (wasOpenRef.current && openedAccountIdRef.current === accountId) return;

    wasOpenRef.current = true;
    openedAccountIdRef.current = accountId;
    setActiveTab(initialTab);
    if (initialTab === 'auth' || initialTab === 'appearance') {
      setActiveSettingsSectionId(initialTab);
    }
    const nextAvatarUrl = cloudAvatarImageUrl(account?.avatarUrl) || '';
    originalAvatarUrlRef.current = nextAvatarUrl;
    setDisplayNameDraft(account?.displayName?.trim() || '');
    setAvatarUrlDraft(nextAvatarUrl);
    setProfileError('');
    setIsSavingProfile(false);
    setIsSigningOut(false);
  }, [account?.accountId, account?.avatarUrl, account?.displayName, initialTab, isOpen, setActiveSettingsSectionId]);

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
      const input = cloudProfileSaveInput({
        displayNameDraft,
        avatarUrlDraft,
        originalAvatarUrl: originalAvatarUrlRef.current,
      });
      await onUpdateProfile(input);
      if (input.avatarUrl) {
        originalAvatarUrlRef.current = input.avatarUrl;
      }
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
    <div className="app-cloud-account-settings-section app-cloud-account-profile max-w-[680px]">
      <div className="flex flex-wrap items-center gap-4 py-3">
        <IdentityAvatar
          kind="human"
          seed={avatarSeed}
          name={displayNameDraft || displayName}
          imageUrl={avatarUrlDraft || undefined}
          className="h-12 w-12 border border-white/10"
        />
        <label className="grid min-w-[16rem] flex-1 gap-1.5 text-[12px] font-medium text-slate-300">
          Display name
          <input
            value={displayNameDraft}
            onChange={(event) => {
              setDisplayNameDraft(event.currentTarget.value);
              if (profileError) setProfileError('');
            }}
            className="app-input-shell h-10 rounded-[14px] px-3 text-[13px] text-white outline-none"
            placeholder="Your display name"
          />
        </label>
        <Button type="button" variant="quiet" className="h-9 rounded-full px-4 text-[12px]" onClick={() => {
          setProfileError('');
          fileInputRef.current?.click();
        }}>
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
      {profileError ? <div className="app-error-text mt-3 text-[12px] text-rose-200">{profileError}</div> : null}
      <div className="app-cloud-account-settings-meta-row mt-5 flex flex-wrap items-center justify-between gap-3 py-3">
        <div className="grid gap-1 text-[11px] text-slate-500">
          {cloudProfileRows(account).map((row) => (
            <div key={row.label}><span className="text-slate-400">{row.label}:</span> {row.value}</div>
          ))}
        </div>
        <div className="flex items-center gap-2">
          {onSignOut ? (
            <Button
              type="button"
              variant="secondary"
              className="h-9 rounded-full border border-rose-400/20 bg-rose-500/10 px-4 text-[12px] text-rose-200 hover:bg-rose-500/15 hover:text-rose-100"
              disabled={isSigningOut}
              onClick={signOut}
            >
              {isSigningOut ? 'Signing out…' : 'Sign out'}
            </Button>
          ) : null}
          <Button type="button" className="h-9 rounded-full px-4 text-[12px]" disabled={isSavingProfile} onClick={saveProfile}>
            {isSavingProfile ? 'Saving…' : 'Save profile'}
          </Button>
        </div>
      </div>
    </div>
  );

  const authPanel = (
    <div className="app-cloud-account-settings-section max-w-[680px]">
      <AuthPage
        variant="settings"
        layoutWidth={Math.min(authSettingsLayoutWidth, 620)}
        settingsLayoutMode="fluid"
        showSettingsHeader={false}
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
    </div>
  );

  const themePanel = (
    <div className="app-cloud-account-settings-section app-cloud-account-theme app-settings-option-list max-w-[680px]">
      {(appearanceSection?.items ?? []).map((item) => (
        <div
          key={item.label}
          className="app-settings-option-row grid items-center gap-3 py-3.5 md:grid-cols-[minmax(0,1fr)_minmax(208px,280px)]"
        >
          <div>
            <div className="text-[13px] font-medium text-white">{item.label}</div>
            {item.hint ? <div className="mt-1 text-[12px] leading-5 text-slate-400">{item.hint}</div> : null}
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
      className="app-transient-overlay app-cloud-account-settings-overlay fixed inset-0 z-[180] flex items-center justify-center px-6 py-6 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-label="Account settings"
        aria-modal="true"
        className="app-transient-surface app-modal-panel app-cloud-account-settings-dialog grid h-[min(680px,calc(100vh-40px))] w-[min(900px,calc(100vw-40px))] grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-[12px] md:grid-cols-[208px_minmax(0,1fr)] md:grid-rows-1"
      >
        <div className="app-session-panel app-cloud-account-settings-rail flex min-h-0 flex-col border-b p-3 md:border-b-0 md:border-r">
          <div className="mb-2 min-w-0 px-2.5 py-2">
            <div className="truncate text-[13px] font-semibold text-white">{displayName}</div>
          </div>
          <div className="app-cloud-account-settings-tabs grid grid-cols-3 gap-1 md:grid-cols-1">
            {tabs.map((tab) => {
              const Icon = tab.icon;
              const active = activeTab === tab.id || (tab.id !== 'profile' && activeSettingsSectionId === tab.id && activeTab === tab.id);
              return (
                <button
                  key={tab.id}
                  type="button"
                  className={cn(
                    'app-settings-nav-item flex min-w-0 items-center gap-2.5 rounded-[12px] px-2.5 py-2 text-left text-[13px] font-medium text-slate-300',
                    active && 'app-settings-nav-item-active text-white',
                  )}
                  onClick={() => selectTab(tab.id)}
                  aria-current={active ? 'page' : undefined}
                >
                  <Icon className="h-4 w-4" />
                  {tab.label}
                </button>
              );
            })}
          </div>
        </div>
        <div className="app-main-panel app-cloud-account-settings-page flex min-h-0 flex-col px-5 py-4 md:px-6 md:py-5">
          <div className="mb-3 flex shrink-0 items-start justify-between gap-3">
            <div>
              <div className="text-[18px] font-semibold tracking-tight text-white">
                {activeTab === 'profile' ? 'Profile' : activeTab === 'auth' ? 'Authentication' : 'Theme'}
              </div>
            </div>
            <button type="button" className="app-button-quiet app-transient-flat-action grid h-8 w-8 place-items-center rounded-full p-0" onClick={onClose} aria-label="Close account settings">
              <X className="h-4 w-4" />
            </button>
          </div>
          <ScrollArea className="min-h-0 flex-1 pr-2">
            {activeTab === 'profile' ? profilePanel : activeTab === 'auth' ? authPanel : themePanel}
          </ScrollArea>
        </div>
      </div>
    </div>,
    document.querySelector('.kordi-app') ?? document.body,
  );
}
