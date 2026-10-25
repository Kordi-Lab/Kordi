import { MessageLayoutSetting } from '@/kordi-app/components/MessageLayoutSetting';
import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { AuthPage } from '@/kordi-app/auth/AuthPage';
import { AppearanceSettingsRow, SettingsNav, SettingsSection } from '@/kordi-app/components';
import type { SettingsSection as SettingsSectionData, SettingsSectionId } from '@/kordi-app/data/settings';
import type { DesktopAuthProvider, DesktopAuthState, ThemeMode } from '@/kordi-app/types';
import {
  cloudApiBaseUrl,
  defaultCloudAuthClient,
  type CloudAccount,
  type CloudAccountEmailVerificationInput,
  type CloudProfileUpdateInput,
  type CloudSignupCodeChallenge,
} from '@/features/cloud/authClient';
import { useCloudAuthCapabilitiesState } from '@/features/cloud/cloudAuthCapabilities';
import { CloudConnectorsHttpClient } from '@/features/cloud/cloudConnectorsClient';
import { CloudDevicesPanel } from '@/features/cloud/CloudDevicesPanel';
import { NotificationSettingsPanel } from '@/features/notifications/NotificationSettingsPanel';
import { ConnectorsSettingsPanel } from '@/features/connectors/ConnectorsSettingsPanel';
import type { ConnectorsClient } from '@/features/connectors/connectorsClient';
import { connectorsClientForAccount } from '@/features/connectors/connectorsClientSelection';
import { useConnectorsLinkSelection } from '@/features/connectors/useConnectorsLinkSelection';
import { MemorySettingsPanel } from '@/features/memory/MemorySettingsPanel';
import { memoryClientForEnvironment, type MemoryClient } from '@/features/memory/memoryClient';
import type { MemoryImporter } from '@/features/memory/memoryImport';
import { nativeMemoryImporter, useMemoryImportRoute } from '@/features/memory/memoryImportClient';
import { useHostedAccountsSnapshot } from '@/features/cloud/hostedAccounts';
import { authStateSatisfiesStartupGate } from '@/kordi-app/auth/model';
import type { DesktopChatMessageRoute } from '@/lib/desktop';
import { cloudAccountSettingsNavGroups, type CloudAccountSettingsTabId } from './cloudAccountSettingsNav';
import { CloudProfilePanel } from './CloudProfilePanel';
import { useCloudProfileEditor } from './useCloudProfileEditor';

export type { CloudAccountSettingsTabId } from './cloudAccountSettingsNav';
export { cloudProfileSaveInput } from './cloudProfileDraft';

// Created once per app load so preview state survives closing the dialog.
const environmentMemoryClient = memoryClientForEnvironment();

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
  /** This Mac's chat route, which Memory › Import runs with. */
  memoryImportRoute?: DesktopChatMessageRoute | null;
};

type CloudAccountSettingsDialogProps = CloudAccountSettingsConfig & {
  isOpen: boolean;
  initialTab?: CloudAccountSettingsTabId;
  account: CloudAccount | null;
  onClose: () => void;
  onUpdateProfile: (input: CloudProfileUpdateInput) => Promise<void>;
  onRequestEmailCode?: () => Promise<CloudSignupCodeChallenge>;
  onVerifyEmail?: (input: CloudAccountEmailVerificationInput) => Promise<void>;
  onEmailAlreadyVerified?: () => Promise<void>;
  onSignOut?: () => Promise<void> | void;
  /**
   * Connectors client override for previews; null hides the section. When
   * omitted, the client follows the server's `connectorsVersion` capability.
   */
  connectorsClient?: ConnectorsClient | null;
  /** Marks an overriding `connectorsClient` as sample data. */
  connectorsIsPreview?: boolean;
  /** Memory client; null hides the Memory section. Defaults to the build environment. */
  memoryClient?: MemoryClient | null;
  /** Agent-file importer override for previews; defaults to this Mac's in the native shell. */
  memoryImporter?: MemoryImporter | null;
};

export function CloudAccountSettingsDialog({
  isOpen,
  initialTab = 'profile',
  account,
  onClose,
  onUpdateProfile,
  onRequestEmailCode,
  onVerifyEmail,
  onEmailAlreadyVerified,
  onSignOut,
  connectorsClient: connectorsClientOverride,
  connectorsIsPreview = false,
  memoryClient = environmentMemoryClient,
  memoryImporter,
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
  memoryImportRoute = null,
}: CloudAccountSettingsDialogProps) {
  const [activeTab, setActiveTab] = useState<CloudAccountSettingsTabId>('profile');
  const profileEditor = useCloudProfileEditor({ account, onUpdateProfile });
  const resetProfileEditor = profileEditor.reset;
  const openedAccountIdRef = useRef<string | null>(null);
  const wasOpenRef = useRef(false);
  const hasConnectorsOverride = connectorsClientOverride !== undefined;
  const connectorsClients = useMemo(
    () => (hasConnectorsOverride ? null : { auth: defaultCloudAuthClient(), http: new CloudConnectorsHttpClient() }),
    [hasConnectorsOverride],
  );
  const capabilitiesState = useCloudAuthCapabilitiesState(account && connectorsClients ? connectorsClients.auth : null, cloudApiBaseUrl());
  const { capabilities, status: capabilitiesStatus, refetch: refetchCapabilities } = capabilitiesState;
  const connectorsAccountId = account?.accountId ?? null;
  const defaultAgentName = account?.defaultAgent?.displayName ?? undefined;
  // Kept per account so the preview client's sample state survives closing the dialog.
  const connectorsSelection = useMemo(() => {
    if (!connectorsAccountId || !connectorsClients) return null;
    return connectorsClientForAccount({
      accountId: connectorsAccountId,
      http: connectorsClients.http,
      capabilities,
      capabilitiesStatus,
      defaultAgentName,
    });
  }, [capabilities, capabilitiesStatus, connectorsAccountId, connectorsClients, defaultAgentName]);
  // The composer's own gate (`hasConfiguredProviderAuth`): a provider on this Mac or a hosted account.
  const hosted = useHostedAccountsSnapshot();
  useMemoryImportRoute(memoryImportRoute);
  const connectorsClient = hasConnectorsOverride ? connectorsClientOverride : connectorsSelection?.client ?? null;
  const connectorsArePreview = hasConnectorsOverride ? connectorsIsPreview : connectorsSelection?.source === 'preview';
  const connectorsServicesStatus = hasConnectorsOverride ? undefined : connectorsSelection?.servicesStatus;
  // A Connectors link opens the provider's detail, also when the dialog is already open.
  const showConnectorsTab = useCallback(() => setActiveTab('connectors'), []);
  const { selection: connectorsLinkSelection, clearSelection: clearConnectorsLinkSelection } = useConnectorsLinkSelection({
    isOpen,
    activeTab,
    showConnectorsTab,
  });
  const capabilitiesStatusRef = useRef(capabilitiesStatus);
  useEffect(() => { capabilitiesStatusRef.current = capabilitiesStatus; }, [capabilitiesStatus]);
  // Opening the Connectors tab retries a failed capabilities fetch once.
  useEffect(() => {
    if (isOpen && activeTab === 'connectors' && capabilitiesStatusRef.current === 'failed') refetchCapabilities();
  }, [activeTab, isOpen, refetchCapabilities]);

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
    resetProfileEditor(account);
  }, [account, initialTab, isOpen, resetProfileEditor, setActiveSettingsSectionId]);

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

  const appearanceSection = settingsSections.find((section) => section.id === 'appearance');
  const navGroups = cloudAccountSettingsNavGroups({
    connectorsAvailable: connectorsClient !== null,
    memoryAvailable: memoryClient !== null,
  });
  const visibleTab: CloudAccountSettingsTabId =
    (activeTab === 'connectors' && !connectorsClient) || (activeTab === 'memory' && !memoryClient) ? 'profile' : activeTab;

  const selectTab = (tabId: CloudAccountSettingsTabId) => {
    if (tabId !== 'connectors') clearConnectorsLinkSelection();
    setActiveTab(tabId);
    if (tabId === 'auth' || tabId === 'notifications' || tabId === 'appearance') {
      setActiveSettingsSectionId(tabId);
    }
  };

  const profilePanel = (
    <CloudProfilePanel
      account={account}
      editor={profileEditor}
      onRequestEmailCode={onRequestEmailCode}
      onVerifyEmail={onVerifyEmail}
      onEmailAlreadyVerified={onEmailAlreadyVerified}
      onSignOut={onSignOut}
      onClose={onClose}
    />
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
        <MessageLayoutSetting />
        {(appearanceSection?.items ?? []).map((item) => (
          <AppearanceSettingsRow key={item.label} item={item} themeMode={themeMode} onSelectThemeMode={setThemeMode} />
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

  const connectorsPanel = connectorsClient ? (
    <ConnectorsSettingsPanel
      key={account.accountId}
      accountId={account.accountId}
      client={connectorsClient}
      isNativeShell={isNativeShell}
      isPreview={connectorsArePreview}
      servicesStatus={connectorsServicesStatus}
      onRetryServices={refetchCapabilities}
      initialProviderId={connectorsLinkSelection?.providerId ?? null}
      initialProviderRequest={connectorsLinkSelection?.request}
    />
  ) : null;

  const memoryPanel = memoryClient ? (
    <div className="app-cloud-account-settings-section max-w-[680px]">
      <MemorySettingsPanel
        key={account.accountId}
        accountId={account.accountId}
        client={memoryClient}
        isNativeShell={isNativeShell}
        importer={memoryImporter === undefined ? (isNativeShell ? nativeMemoryImporter : null) : memoryImporter}
        providerReady={authStateSatisfiesStartupGate(desktopAuthState, hosted.accounts)}
      />
    </div>
  ) : null;

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
        <div className="app-cloud-account-settings-rail flex min-h-0 flex-col overflow-y-auto border-b px-3 pb-3 pt-5 md:border-b-0 md:border-r">
          <SettingsNav
            className="app-cloud-account-settings-tabs"
            groups={navGroups}
            activeId={visibleTab}
            onSelect={selectTab}
          />
        </div>
        <div className="app-main-panel app-cloud-account-settings-page flex min-h-0 flex-col">
          <div className="app-cloud-account-settings-header flex h-14 shrink-0 items-center justify-end px-4">
            <button type="button" className="app-button-quiet app-transient-flat-action grid h-8 w-8 place-items-center rounded-full p-0" onClick={onClose} aria-label="Close account settings">
              <X className="h-4 w-4" />
            </button>
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <div className="px-8 pb-8 pt-2">
              {visibleTab === 'profile' ? profilePanel : visibleTab === 'devices' ? devicesPanel : visibleTab === 'auth' ? authPanel : visibleTab === 'notifications' ? notificationsPanel : visibleTab === 'connectors' ? connectorsPanel : visibleTab === 'memory' ? memoryPanel : appearancePanel}
            </div>
          </ScrollArea>
        </div>
      </div>
    </div>,
    document.querySelector('.kordi-app') ?? document.body,
  );
}
