import { useEffect, useId, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { createPortal } from 'react-dom';
import { Bell, Camera, KeyRound, Laptop, Palette, User, X } from 'lucide-react';

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
import { CloudDevicesPanel } from '@/features/cloud/CloudDevicesPanel';
import { formatKordiHandle } from '@/features/cloud/kordiId';
import { cn } from '@/lib/utils';
import { NotificationSettingsPanel } from '@/features/notifications/NotificationSettingsPanel';

export type CloudAccountSettingsTabId = 'profile' | 'devices' | 'auth' | 'notifications' | 'appearance';

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
  const kordiHandle = formatKordiHandle(account.kordiId);
  return [
    kordiHandle ? { label: 'Kordi ID', value: kordiHandle } : null,
    account.primaryEmail?.trim() ? { label: 'Email', value: account.primaryEmail.trim() } : null,
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
  const profileErrorId = useId();
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
    if (initialTab === 'auth' || initialTab === 'notifications' || initialTab === 'appearance') {
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
  const isDisplayNameInvalid = Boolean(profileError && !displayNameDraft.trim());
  const avatarSeed = cloudAvatarSeedForAccount(account.accountId, account.avatarUrl) || localProfileAvatarSeed || account.accountId;
  const appearanceSection = settingsSections.find((section) => section.id === 'appearance');
  const tabs: Array<{ id: CloudAccountSettingsTabId; label: string; icon: typeof User }> = [
    { id: 'profile', label: 'Profile', icon: User },
    { id: 'devices', label: 'Active sessions', icon: Laptop },
    { id: 'auth', label: 'Authentication', icon: KeyRound },
    { id: 'notifications', label: 'Notifications', icon: Bell },
    { id: 'appearance', label: 'Appearance', icon: Palette },
  ];

  const selectTab = (tabId: CloudAccountSettingsTabId) => {
    setActiveTab(tabId);
    if (tabId === 'auth' || tabId === 'notifications' || tabId === 'appearance') {
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
    <div className="app-cloud-account-settings-section app-cloud-account-profile max-w-[620px] py-2">
      <div className="grid grid-cols-[88px_minmax(0,1fr)] items-start gap-5">
        <div className="grid justify-items-center gap-2.5">
          <IdentityAvatar
            kind="human"
            seed={avatarSeed}
            name={displayNameDraft || displayName}
            imageUrl={avatarUrlDraft || undefined}
            className="h-16 w-16 border border-white/10"
          />
          <Button type="button" variant="quiet" className="h-8 rounded-full px-2.5 text-[11px]" onClick={() => {
            setProfileError('');
            fileInputRef.current?.click();
          }}>
            <Camera className="h-3.5 w-3.5" />
            Change
          </Button>
        </div>
        <div className="min-w-0">
          <label className="grid gap-2 text-[12px] font-medium text-slate-300">
            Display name
            <input
              value={displayNameDraft}
              onChange={(event) => {
                setDisplayNameDraft(event.currentTarget.value);
                if (profileError) setProfileError('');
              }}
              className={cn(
                'app-input-shell app-flat-input app-cloud-account-profile-name-input h-10 w-full rounded-[10px] px-3 text-[13px] text-white outline-none',
                isDisplayNameInvalid && 'app-flat-input-error',
              )}
              placeholder="Your display name"
              aria-invalid={isDisplayNameInvalid || undefined}
              aria-describedby={profileError ? profileErrorId : undefined}
            />
          </label>
          <dl className="mt-4 grid gap-3 sm:grid-cols-2">
            {cloudProfileRows(account).map((row) => (
              <div key={row.label} className="min-w-0">
                <dt className="text-[11px] text-slate-500">{row.label}</dt>
                <dd className="mt-0.5 truncate text-[12px] text-slate-300" title={row.value}>{row.value}</dd>
              </div>
            ))}
          </dl>
        </div>
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
      {profileError ? <div id={profileErrorId} className="app-error-text mt-3 text-[12px] text-rose-200 sm:pl-[108px]" aria-live="polite">{profileError}</div> : null}
      <div className={cn(
        'app-cloud-account-settings-meta-row mt-6 flex flex-wrap items-center gap-3 sm:pl-[108px]',
        onSignOut ? 'justify-between' : 'justify-end',
      )}>
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

  const appearancePanel = (
    <div className="app-cloud-account-settings-section app-cloud-account-theme app-settings-option-list max-w-[620px] py-2">
      {(appearanceSection?.items ?? []).map((item) => (
        <div
          key={item.label}
          className="app-settings-option-row grid gap-4 py-3"
        >
          <div>
            <div className="text-[13px] font-medium text-white">{item.label}</div>
            {item.hint ? <div className="mt-1 text-[12px] leading-5 text-slate-400">{item.hint}</div> : null}
          </div>
          <div className="w-full">
            <SettingsValueControl item={item} themeMode={themeMode} onSelectThemeMode={setThemeMode} />
          </div>
        </div>
      ))}
    </div>
  );

  const notificationsPanel = (
    <div className="app-cloud-account-settings-section max-w-[680px] py-2">
      <NotificationSettingsPanel isNativeShell={isNativeShell} />
    </div>
  );

  const devicesPanel = <CloudDevicesPanel key={account.accountId} accountId={account.accountId} />;

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
          <div className="app-cloud-account-settings-tabs grid grid-cols-5 gap-1 md:grid-cols-1">
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
                {activeTab === 'profile' ? 'Profile' : activeTab === 'devices' ? 'Active sessions' : activeTab === 'auth' ? 'Authentication' : activeTab === 'notifications' ? 'Notifications' : 'Appearance'}
              </div>
            </div>
            <button type="button" className="app-button-quiet app-transient-flat-action grid h-8 w-8 place-items-center rounded-full p-0" onClick={onClose} aria-label="Close account settings">
              <X className="h-4 w-4" />
            </button>
          </div>
          <ScrollArea className="min-h-0 flex-1 pr-2">
            {activeTab === 'profile' ? profilePanel : activeTab === 'devices' ? devicesPanel : activeTab === 'auth' ? authPanel : activeTab === 'notifications' ? notificationsPanel : appearancePanel}
          </ScrollArea>
        </div>
      </div>
    </div>,
    document.querySelector('.kordi-app') ?? document.body,
  );
}
