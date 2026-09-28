import { useEffect, useId, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { createPortal } from 'react-dom';
import { Bell, KeyRound, Laptop, Palette, User, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { AuthPage } from '@/kordi-app/auth/AuthPage';
import { SettingsNav, SettingsRow, SettingsSection, SettingsValueControl, type SettingsNavGroup } from '@/kordi-app/components';
import { EditableIdentityAvatar } from '@/kordi-app/components/EditableIdentityAvatar';
import type { SettingsSection as SettingsSectionData, SettingsSectionId } from '@/kordi-app/data/settings';
import type { DesktopAuthProvider, DesktopAuthState, ThemeMode } from '@/kordi-app/types';
import type { CloudAccount, CloudProfileUpdateInput } from '@/features/cloud/authClient';
import { CloudDevicesPanel } from '@/features/cloud/CloudDevicesPanel';
import { formatKordiHandle } from '@/features/cloud/kordiId';
import { cn } from '@/lib/utils';
import { NotificationSettingsPanel } from '@/features/notifications/NotificationSettingsPanel';
import {
  canonicalAvatarImageSource,
  generatedAvatarPreviewUrl,
  newCanonicalAvatarSeed,
  type CanonicalAvatarMutation,
} from '@/features/cloud/canonicalAvatar';

export type CloudAccountSettingsTabId = 'profile' | 'devices' | 'auth' | 'notifications' | 'appearance';

export type CloudAccountSettingsConfig = {
  settingsSections: SettingsSectionData[];
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
  avatarMutationDraft,
}: {
  displayNameDraft: string;
  avatarMutationDraft: CanonicalAvatarMutation | null;
}): CloudProfileUpdateInput {
  const input: CloudProfileUpdateInput = { displayName: displayNameDraft.trim() };
  if (avatarMutationDraft) input.avatarMutation = avatarMutationDraft;
  return input;
}

export function CloudAccountSettingsDialog({
  isOpen,
  initialTab = 'profile',
  account,
  onClose,
  onUpdateProfile,
  onSignOut,
  settingsSections,
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
  const [avatarMutationDraft, setAvatarMutationDraft] = useState<CanonicalAvatarMutation | null>(null);
  const [profileError, setProfileError] = useState('');
  const [isSavingProfile, setIsSavingProfile] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const profileErrorId = useId();
  const openedAccountIdRef = useRef<string | null>(null);
  const wasOpenRef = useRef(false);

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
    const nextAvatarUrl = account ? canonicalAvatarImageSource(account.avatar) ?? '' : '';
    setDisplayNameDraft(account?.displayName?.trim() || '');
    setAvatarUrlDraft(nextAvatarUrl);
    setAvatarMutationDraft(null);
    setProfileError('');
    setIsSavingProfile(false);
    setIsSigningOut(false);
  }, [account, initialTab, isOpen, setActiveSettingsSectionId]);

  useEffect(() => {
    if (!isOpen || typeof window === 'undefined') return;
    // A page inside the dialog that handles Escape itself (a running sign-in, for example) marks it handled.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen || !account || typeof document === 'undefined') return null;

  const displayName = profileDisplayName(account);
  const isDisplayNameInvalid = Boolean(profileError && !displayNameDraft.trim());
  const avatarSeed = account.avatar.seed;
  const appearanceSection = settingsSections.find((section) => section.id === 'appearance');
  const navGroups: Array<SettingsNavGroup<CloudAccountSettingsTabId>> = [
    {
      label: 'Account',
      items: [
        { id: 'profile', label: 'Profile', icon: User, keywords: ['name', 'avatar', 'sign out'] },
        { id: 'devices', label: 'Active sessions', icon: Laptop, keywords: ['devices'] },
      ],
    },
    {
      label: 'Settings',
      items: [
        { id: 'auth', label: 'Authentication', icon: KeyRound, keywords: ['providers', 'accounts', 'api key', 'omp'] },
        { id: 'notifications', label: 'Notifications', icon: Bell, keywords: ['alerts', 'sound', 'badge'] },
        { id: 'appearance', label: 'Appearance', icon: Palette, keywords: ['theme', 'dark', 'light'] },
      ],
    },
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
        avatarMutationDraft,
      });
      await onUpdateProfile(input);
      setAvatarMutationDraft(null);
    } catch (caught) {
      setProfileError(caught instanceof Error ? caught.message : 'Could not save profile.');
    } finally {
      setIsSavingProfile(false);
    }
  };

  const handleAvatarUpload = (dataUrl: string) => {
    setAvatarUrlDraft(dataUrl);
    setAvatarMutationDraft({
      action: 'upload',
      uploadedAsset: dataUrl,
      expectedVersion: account.avatar.version,
    });
    setProfileError('');
  };

  const useAnotherGeneratedAvatar = () => {
    const seed = newCanonicalAvatarSeed();
    const style = account.avatar.style;
    const previewUrl = generatedAvatarPreviewUrl(style, seed);
    if (!previewUrl) {
      setProfileError('Could not create a random avatar.');
      return;
    }
    setAvatarUrlDraft(previewUrl);
    setAvatarMutationDraft({
      action: 'regenerate',
      seed,
      expectedVersion: account.avatar.version,
    });
    setProfileError('');
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
    <div className="app-cloud-account-settings-section app-cloud-account-profile max-w-[620px]">
      <SettingsSection title="Profile">
        <div className="grid grid-cols-[96px_minmax(0,1fr)] items-center gap-5 py-4">
          <div className="flex justify-center">
            <EditableIdentityAvatar
              kind="human"
              seed={avatarSeed}
              name={displayNameDraft || displayName}
              imageUrl={avatarUrlDraft || undefined}
              className="h-16 w-16 border border-white/10"
              label="Profile avatar"
              generateLabel="Random avatar"
              onUpload={handleAvatarUpload}
              onGenerate={useAnotherGeneratedAvatar}
            />
          </div>
          <label className="grid min-w-0 gap-2 text-[13px] font-medium text-white">
            Display name
            <input
              value={displayNameDraft}
              onChange={(event) => {
                setDisplayNameDraft(event.currentTarget.value);
                if (profileError) setProfileError('');
              }}
              className={cn(
                'app-input-shell app-flat-input app-cloud-account-profile-name-input h-10 w-full rounded-[10px] px-3 text-[13px] font-normal text-white outline-none',
                isDisplayNameInvalid && 'app-flat-input-error',
              )}
              placeholder="Your display name"
              aria-invalid={isDisplayNameInvalid || undefined}
              aria-describedby={profileError ? profileErrorId : undefined}
            />
          </label>
        </div>
        {cloudProfileRows(account).map((row) => (
          <SettingsRow
            key={row.label}
            title={row.label}
            control={<span className="max-w-[280px] truncate text-[13px] text-slate-300" title={row.value}>{row.value}</span>}
          />
        ))}
        <SettingsRow
          title="Save changes"
          description={profileError
            ? <span id={profileErrorId} className="app-error-text text-rose-200" aria-live="polite">{profileError}</span>
            : 'Your name and avatar are shown to your contacts.'}
          control={(
            <Button type="button" className="h-8 rounded-lg px-3.5 text-[12px]" disabled={isSavingProfile} onClick={saveProfile}>
              {isSavingProfile ? 'Saving…' : 'Save profile'}
            </Button>
          )}
        />
      </SettingsSection>
      {onSignOut ? (
        <SettingsSection title="Session">
          <SettingsRow
            title="Sign out"
            description="Sign out of Kordi on this Mac."
            className="app-cloud-account-settings-meta-row"
            control={(
              <Button
                type="button"
                variant="secondary"
                className="h-8 rounded-lg border border-rose-400/20 bg-rose-500/10 px-3.5 text-[12px] text-rose-200 hover:bg-rose-500/15 hover:text-rose-100"
                disabled={isSigningOut}
                onClick={signOut}
              >
                {isSigningOut ? 'Signing out…' : 'Sign out'}
              </Button>
            )}
          />
        </SettingsSection>
      ) : null}
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
    <div className="app-cloud-account-settings-section app-cloud-account-theme app-settings-option-list max-w-[680px]">
      <SettingsSection title="Appearance">
        {(appearanceSection?.items ?? []).map((item) => (
          <SettingsRow
            key={item.label}
            className="app-settings-option-row"
            title={item.label}
            description={item.hint}
            control={<SettingsValueControl item={item} themeMode={themeMode} onSelectThemeMode={setThemeMode} />}
          />
        ))}
      </SettingsSection>
    </div>
  );

  const notificationsPanel = (
    <div className="app-cloud-account-settings-section max-w-[680px]">
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
        <div className="app-session-panel app-cloud-account-settings-rail flex min-h-0 flex-col overflow-y-auto border-b p-3 md:border-b-0 md:border-r">
          <SettingsNav
            className="app-cloud-account-settings-tabs"
            groups={navGroups}
            activeId={activeTab}
            onSelect={selectTab}
          />
        </div>
        <div className="app-main-panel app-cloud-account-settings-page relative flex min-h-0 flex-col">
          <div className="absolute right-3 top-3 z-10">
            <button type="button" className="app-button-quiet app-transient-flat-action grid h-8 w-8 place-items-center rounded-full p-0" onClick={onClose} aria-label="Close account settings">
              <X className="h-4 w-4" />
            </button>
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <div className="px-8 pb-8 pt-10">
              {activeTab === 'profile' ? profilePanel : activeTab === 'devices' ? devicesPanel : activeTab === 'auth' ? authPanel : activeTab === 'notifications' ? notificationsPanel : appearancePanel}
            </div>
          </ScrollArea>
        </div>
      </div>
    </div>,
    document.querySelector('.kordi-app') ?? document.body,
  );
}
