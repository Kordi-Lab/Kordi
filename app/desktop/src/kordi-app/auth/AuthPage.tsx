import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import type { DesktopAuthProvider, DesktopAuthState } from '@/kordi-app/types';
import { defaultCloudAuthClient } from '@/features/cloud/authClient';
import type { CloudProviderAuthSnapshot } from '@/features/cloud/cloudAgentRuntimeTypes';
import { loadSession } from '@/features/cloud/session';
import type { CloudProviderAuthSnapshotInput, CloudProviderRouteTestInput, CloudProviderRouteTestResult } from '@/features/cloud/cloudAgentRuntimeTypes';
import { createCloudProviderAuthApi } from '@/features/cloud/providerAuthClient';
import { createCloudProviderLoginClient, type ProviderLoginClient, type ProviderLoginSnapshot } from '@/features/cloud/providerLogin';
import { createDesktopLoginCallbackCapture, type LoginCallbackCapture } from '@/features/cloud/loginCallbackCapture';
import { publishHostedProviderSnapshots } from '@/features/cloud/hostedAccounts';
import { testCloudProviderRoute } from '@/features/cloud/providerRouteTest';
import { publishableAccountLabel } from '@/features/cloud/routeAccountChoice';
import { OMP_UNAVAILABLE_MESSAGE } from '@/features/cloud/ompAvailability';
import { openDesktopExternalUrl, type DesktopChatMessageRoute } from '@/lib/desktop';
import { AuthActionButton, authButtonPrimaryClass } from './AuthDetailPrimitives';
import { AuthProviderDetail } from './AuthProviderDetail';
import { AuthProviderGlyph } from './AuthProviderGlyph';
import { buildAddMethods, resolveAddMethod, type AuthAddRoute } from './authAddMethods';
import { providerShortName } from './providerCopy';
import { AuthProviderList } from './AuthProviderList';
import { isLocalProvider, normalizeSelectedProviderId, type AuthDisplayProvider } from './model';
import { continueChatProvider, hasActiveAccount, startChatBlockedReason, startChatTarget, withActiveAccount } from './authRouteAccounts';
import { buildOmpDisplayProviders, type OmpCatalogEntry } from './ompCatalog';
import { LOCAL_ACCOUNTS_UNAVAILABLE_NOTICE, useAuthOmpCatalog } from './useAuthOmpCatalog';

type AuthRoute =
  | { type: 'list' }
  | { type: 'detail'; providerId: string; add?: AuthAddRoute | null };

async function loadCloudSnapshots() {
  const session = await loadSession();
  return session ? createCloudProviderAuthApi().listProviderAuthSnapshots(session.token, false) : [];
}

async function revokeCloudSnapshot(snapshotId: string) {
  const session = await loadSession();
  if (!session) throw new Error('Sign in to Kordi first.');
  await defaultCloudAuthClient().revokeProviderAuthSnapshot(session.token, snapshotId);
}

/** Hosted data the auth page reads; synthetic previews replace it to stay offline. */
export type AuthPageCloudSources = {
  /** Optional refresh of the bundled OMP catalog; null keeps the bundled catalog. */
  loadCatalog: (() => Promise<{ providers: OmpCatalogEntry[]; version?: string | null }>) | null;
  loadSnapshots: () => Promise<CloudProviderAuthSnapshot[]>;
  /** Hosted OMP sign-in sessions; null leaves only on-this-Mac sign-in. */
  login?: ProviderLoginClient | null;
  /** Receives a browser sign-in's localhost redirect; null leaves the paste field. */
  callbackCapture?: LoginCallbackCapture | null;
  revokeSnapshot?: (snapshotId: string) => Promise<void>;
  openExternal?: (url: string) => void;
};

const defaultCloudSources: AuthPageCloudSources = {
  loadCatalog: () => createCloudProviderAuthApi().ompProviderCatalog(),
  loadSnapshots: loadCloudSnapshots,
  login: createCloudProviderLoginClient(),
  callbackCapture: createDesktopLoginCallbackCapture(),
  revokeSnapshot: revokeCloudSnapshot,
  openExternal: (url) => { void Promise.resolve(openDesktopExternalUrl(url)).catch(() => undefined); },
};

function snapshotNeedsReconnect(snapshot: CloudProviderAuthSnapshot) {
  return !snapshot.revokedAt && (snapshot.status === 'needs-reconnect' || snapshot.status === 'needs_reconnect');
}

function snapshotFromLogin(snapshot: ProviderLoginSnapshot): CloudProviderAuthSnapshot {
  return { ...snapshot, modelHint: null, createdAt: new Date().toISOString(), revokedAt: null };
}

export type AuthPageProps = {
  variant: 'settings' | 'gate';
  layoutWidth: number;
  isNativeShell: boolean;
  authState: DesktopAuthState | null;
  isLoading: boolean;
  error: string | null;
  selectedProviderId: string | null;
  onSelectProvider: (providerId: string) => void;
  onOpenLogin: (
    provider: DesktopAuthProvider,
    mode: 'oauth' | 'api-key',
    options?: { authority?: string; requireAuthority?: boolean },
  ) => void;
  onRefresh: () => void;
  onSelectAuthChoice: (providerId: string, choice: string) => void;
  onRemoveAuthProfile: (providerId: string, profileId: string) => void;
  onLogoutProvider: (providerId: string) => void;
  onDismissGate?: () => void;
  /** A hosted-only account's chat also carries its route, so it runs on Kordi Cloud. */
  onEnterChat?: (preferredModelValue?: string, route?: DesktopChatMessageRoute) => void | Promise<void>;
  onTestRoute?: (input: CloudProviderRouteTestInput) => Promise<CloudProviderRouteTestResult>;
  onSaveCloudKey?: (input: CloudProviderAuthSnapshotInput) => Promise<void>;
  onValidateCloudKey?: (providerId: string, apiKey: string) => Promise<{ verified: boolean }>;
  showSettingsHeader?: boolean;
  settingsLayoutMode?: 'fixed' | 'fluid';
  cloudSources?: AuthPageCloudSources;
  /** Opens this provider's detail on first render instead of the list. */
  initialDetailProviderId?: string | null;
  /** Also opens the add-account flow for this OMP provider id. */
  initialLoginProviderId?: string | null;
  /** Method kind or key for the add-account flow, for example `device` or `api-key`. */
  initialLoginMethod?: string | null;
};

export function AuthPage({
  variant,
  layoutWidth,
  isNativeShell,
  authState,
  isLoading,
  error,
  selectedProviderId,
  onSelectProvider,
  onOpenLogin,
  onRefresh,
  onSelectAuthChoice,
  onRemoveAuthProfile,
  onLogoutProvider,
  onDismissGate,
  onEnterChat,
  onTestRoute,
  onSaveCloudKey,
  onValidateCloudKey,
  showSettingsHeader = true,
  settingsLayoutMode = 'fixed',
  cloudSources = defaultCloudSources,
  initialDetailProviderId = null,
  initialLoginProviderId = null,
  initialLoginMethod = null,
}: AuthPageProps) {
  const showHero = variant === 'gate';
  const showNativeNote = !isNativeShell && variant === 'settings';
  const [cloudSnapshots, setCloudSnapshots] = useState<CloudProviderAuthSnapshot[]>([]);
  // Set once when the catalog or a sign-in start finds no OMP on the backend (404 or not
  // configured); a transient OMP failure elsewhere never sets it. Never retried in a loop.
  const [ompUnavailable, setOmpUnavailable] = useState(false);
  const noteOmpUnavailable = useCallback(() => setOmpUnavailable(true), []);
  // The pinned catalog is its own chunk; until it arrives the page shows its loading state.
  const { catalog: ompCatalog, notice: catalogNotice } = useAuthOmpCatalog(cloudSources.loadCatalog, noteOmpUnavailable);
  const [cloudActionError, setCloudActionError] = useState<string | null>(null);
  // The composer offers hosted Custom API models, so every load is shared with it.
  const applySnapshots = (snapshots: CloudProviderAuthSnapshot[]) => {
    setCloudSnapshots(snapshots);
    publishHostedProviderSnapshots(snapshots);
  };
  const refreshCloudSnapshots = async () => {
    applySnapshots(await cloudSources.loadSnapshots());
  };
  useEffect(() => {
    void cloudSources.loadSnapshots().then((snapshots) => {
      setCloudSnapshots(snapshots);
      publishHostedProviderSnapshots(snapshots);
    }).catch(() => {});
  }, [cloudSources]);
  const { authState: displayAuthState, providers: visibleProviders } = useMemo(
    () => buildOmpDisplayProviders(authState, cloudSnapshots, ompCatalog?.providers ?? []),
    [authState, cloudSnapshots, ompCatalog],
  );
  const configuredCount = visibleProviders.filter((item) => item.configured).length;

  const [currentRoute, setCurrentRoute] = useState<AuthRoute>(() => {
    const providerId = normalizeSelectedProviderId(initialDetailProviderId);
    if (!providerId) return { type: 'list' };
    const add = initialLoginProviderId
      ? { provider: initialLoginProviderId, ...(initialLoginMethod ? { method: initialLoginMethod } : {}) }
      : null;
    return { type: 'detail', providerId, add };
  });
  const [recentlyAdded, setRecentlyAdded] = useState<string[]>([]);
  // Hosted accounts this page made active, by provider, while no other account is.
  const [activeHosted, setActiveHosted] = useState<Record<string, string>>({});

  // Accounts added in this visit carry a brief "Added" badge.
  useEffect(() => {
    if (recentlyAdded.length === 0) return;
    const timer = window.setTimeout(() => setRecentlyAdded([]), 8000);
    return () => window.clearTimeout(timer);
  }, [recentlyAdded]);
  const detailProviderId =
    currentRoute.type === 'detail'
      ? currentRoute.providerId
      : normalizeSelectedProviderId(selectedProviderId);
  const shownProvider =
    visibleProviders.find((item) => item.id === detailProviderId) ??
    visibleProviders.find((item) => item.id === normalizeSelectedProviderId(selectedProviderId)) ??
    visibleProviders[0] ??
    null;
  const provider = shownProvider ? withActiveAccount(shownProvider, activeHosted[shownProvider.id]) : null;

  // A new account is highlighted, and becomes the active one when the provider had none.
  const noteAccountAdded = (authChoice: string) => {
    setRecentlyAdded((current) => [...current, authChoice]);
    if (provider && !hasActiveAccount(provider)) setActiveHosted((current) => ({ ...current, [provider.id]: authChoice }));
  };
  const canStartChat = Boolean(onEnterChat) && !!provider && !isLocalProvider(provider.id);
  const chatBlocked = canStartChat && provider ? startChatBlockedReason(provider) : null;
  // Start chat uses the active account (choosing the first when none is) and its model.
  const startChat = (target: AuthDisplayProvider) => {
    const chat = startChatTarget(target);
    if (!chat || !onEnterChat || startChatBlockedReason(target)) return;
    if (!chat.account.active && chat.account.hosted) setActiveHosted((current) => ({ ...current, [target.id]: chat.account.value }));
    else if (!chat.account.active) onSelectAuthChoice(chat.account.providerId, chat.account.value);
    if (showHero) onDismissGate?.();
    const route = chat.model && chat.account.hosted
      ? { model: chat.model, authProvider: chat.account.providerId, authChoice: chat.account.value }
      : undefined;
    void onEnterChat(chat.model ?? undefined, route);
  };
  const continueChat = () => {
    const next = continueChatProvider(visibleProviders.map((item) => withActiveAccount(item, activeHosted[item.id])));
    if (!next) void onEnterChat?.();
    else if (next.blocked) openProviderDetail(next.provider.id);
    else startChat(next.provider);
  };

  const openProviderDetail = (providerId: string) => {
    onSelectProvider(providerId);
    setCurrentRoute({ type: 'detail', providerId });
  };

  const goToProviderList = () => {
    setCurrentRoute({ type: 'list' });
  };

  const showDetailPage = ompCatalog !== null && currentRoute.type === 'detail' && !!provider;

  const content = (() => {
    if (showNativeNote) {
      return (
        <div className="app-surface-muted rounded-[28px] px-5 py-5 text-sm text-slate-300">
          Native desktop sign-in appears here. Open `pnpm dev:desktop` to test provider login, saved accounts, logout, and browser callback flows.
        </div>
      );
    }

    if (isLoading || !ompCatalog) {
      return (
        <div className="app-surface-muted rounded-[28px] px-5 py-5 text-sm text-slate-300">
          Loading providers…
        </div>
      );
    }

    if (!showDetailPage) {
      return (
        <AuthProviderList
          providers={visibleProviders}
          catalogCaption={ompCatalog.version ? `OMP catalog ${ompCatalog.version}` : 'OMP catalog'}
          notice={[
            ompUnavailable ? OMP_UNAVAILABLE_MESSAGE : null,
            catalogNotice,
            authState ? null : LOCAL_ACCOUNTS_UNAVAILABLE_NOTICE,
          ].filter(Boolean).join(' ') || null}
          onSelectProvider={openProviderDetail}
          onRefresh={onRefresh}
          variant={showHero ? 'gate' : 'settings'}
        />
      );
    }

    return (
      <AuthProviderDetail
        key={`${provider?.id ?? 'none'}:${provider?.preferredModel ?? ''}`}
        provider={provider}
        rawProviders={displayAuthState?.providers ?? []}
        authPath={authState?.authPath}
        error={cloudActionError ?? error}
        onOpenLogin={onOpenLogin}
        onSelectAuthChoice={onSelectAuthChoice}
        onRemoveAuthProfile={(providerId, profileId) => {
          if (profileId.startsWith('snap_')) {
            setCloudActionError(null);
            void (cloudSources.revokeSnapshot ?? revokeCloudSnapshot)(profileId)
              .then(refreshCloudSnapshots)
              .catch((caught) => setCloudActionError(caught instanceof Error ? caught.message : 'Could not remove this account.'));
          } else onRemoveAuthProfile(providerId, profileId);
        }}
        loginClient={cloudSources.login ?? null}
        loginCallbackCapture={cloudSources.callbackCapture ?? null}
        openExternal={cloudSources.openExternal}
        addRoute={currentRoute.type === 'detail' ? currentRoute.add ?? null : null}
        onAddRouteChange={(add) => setCurrentRoute((route) => (route.type === 'detail' ? { ...route, add } : route))}
        recentlyAdded={recentlyAdded}
        needsReconnect={cloudSnapshots.filter(snapshotNeedsReconnect).map((snapshot) => snapshot.authChoice)}
        onAccountAdded={noteAccountAdded}
        onStartChat={canStartChat && !chatBlocked && provider ? () => startChat(provider) : undefined}
        onLoginCompleted={(snapshot) => {
          noteAccountAdded(snapshot.authChoice);
          setCloudSnapshots((current) => (current.some((item) => item.snapshotId === snapshot.snapshotId)
            ? current : [...current, snapshotFromLogin(snapshot)]));
          void refreshCloudSnapshots().catch(() => undefined);
        }}
        onLogoutProvider={onLogoutProvider}
        onRefreshAuth={onRefresh}
        onDismissGate={onDismissGate}
        onEnterChat={onEnterChat}
        onTestRoute={onTestRoute ?? testCloudProviderRoute}
        ompUnavailable={ompUnavailable}
        onOmpUnavailable={noteOmpUnavailable}
        onValidateCloudKey={onValidateCloudKey ?? (async (providerId, apiKey) => {
          const session = await loadSession();
          if (!session) throw new Error('Sign in to Kordi before adding an account.');
          return createCloudProviderAuthApi().validateOmpProviderKey(session.token, providerId, apiKey);
        })}
        onSaveCloudKey={async (input) => {
          if (onSaveCloudKey) { await onSaveCloudKey(input); await refreshCloudSnapshots(); return; }
          const session = await loadSession();
          if (!session) throw new Error('Sign in to Kordi before saving an account.');
          await defaultCloudAuthClient().publishProviderAuthSnapshot(session.token, { ...input, label: publishableAccountLabel(input.label) });
          await refreshCloudSnapshots();
        }}
      />
    );
  })();

  // The header follows the add-account layer: the provider page shows the full
  // name once; the picker and login pages show a short title and a Back button.
  const addRoute = currentRoute.type === 'detail' ? currentRoute.add ?? null : null;
  const addMethods = showDetailPage && provider && addRoute ? buildAddMethods(provider, displayAuthState?.providers ?? []) : [];
  const addMethod = addRoute ? resolveAddMethod(addMethods, addRoute) : null;
  const layerTitle = !addRoute || !provider ? null
    : addRoute.account ? 'Edit account'
      : addMethod ? addMethod.pageTitle : `Add ${providerShortName(provider.label)} account`;
  const leaveLayer = () => setCurrentRoute((route) => (route.type === 'detail'
    ? { ...route, add: addMethods.length > 1 && route.add?.method ? {} : null }
    : route));
  const detailHeader = showDetailPage && provider ? (
    <div className="flex shrink-0 items-center gap-3 border-b border-[color:var(--app-divider)] pb-4">
      <Button
        type="button"
        variant="quiet"
        className="-ml-2 h-8 rounded-lg px-2.5 text-[12px]"
        onClick={layerTitle ? leaveLayer : goToProviderList}
      >
        <ChevronLeft className="mr-1 h-3.5 w-3.5" />
        {layerTitle ? 'Back' : 'Back to providers'}
      </Button>
      <span aria-hidden="true" className="h-4 w-px bg-[color:var(--app-divider)]" />
      {layerTitle ? null : <AuthProviderGlyph providerId={provider.id} label={provider.label} size="sm" />}
      <h1 className="m-0 min-w-0 truncate text-[15px] font-semibold tracking-[-0.01em] text-white">{layerTitle ?? provider.label}</h1>
      {!layerTitle && canStartChat ? (
        <AuthActionButton
          type="button"
          className={cn(authButtonPrimaryClass, 'ml-auto shrink-0')}
          disabled={Boolean(chatBlocked)}
          title={chatBlocked ?? undefined}
          onClick={() => startChat(provider)}
        >
          Start chat
        </AuthActionButton>
      ) : null}
    </div>
  ) : null;

  const settingsDetailContent = showDetailPage ? (
    <div
      data-auth-provider-detail-column
      className="min-h-0 w-full min-w-0 max-w-3xl pb-6"
    >
      {detailHeader}
      {content}
    </div>
  ) : (
    <div className="flex min-h-0 w-full min-w-0 max-w-none flex-1 flex-col overflow-hidden" style={{ width: '100%', maxWidth: '100%' }}>{content}</div>
  );

  return (
    <div
      className={cn('relative z-10 block min-h-0 w-full min-w-0 max-w-none pointer-events-auto', (showHero || variant === 'settings') ? 'h-full' : '')}
      style={
        showHero
          ? { WebkitAppRegion: 'no-drag' as const }
          : settingsLayoutMode === 'fluid'
        ? {
            width: '100%',
            minWidth: 0,
            maxWidth: '100%',
            WebkitAppRegion: 'no-drag' as const,
          }
        : {
            width: `${layoutWidth}px`,
            minWidth: `${layoutWidth}px`,
            maxWidth: `${layoutWidth}px`,
            WebkitAppRegion: 'no-drag' as const,
          }
      }
    >
      {showHero ? (
        showDetailPage ? (
          <div className="app-auth-gate-shell app-auth-provider-detail-shell flex h-full min-h-0 w-full items-start justify-center overflow-hidden rounded-none border-0 bg-transparent px-8 py-8 shadow-none">
            <div className="flex min-h-0 w-full max-w-[820px] flex-col">
              <div className="w-full max-w-3xl">{detailHeader}</div>
              <ScrollArea className="min-h-0 flex-1 pr-2">
                <div className="min-h-0 w-full max-w-3xl pb-6">{content}</div>
              </ScrollArea>
            </div>
          </div>
        ) : (
          <div className="app-auth-gate-shell flex h-full min-h-0 w-full justify-center overflow-y-auto rounded-none border-0 bg-transparent px-5 py-10 shadow-none sm:px-8 sm:py-16">
            <div className="w-full max-w-[600px]">
              <div className="mb-7 flex flex-wrap items-start justify-between gap-4">
                <div>
                  <h1 className="text-[30px] font-semibold leading-tight tracking-[-0.035em] text-white">
                    {configuredCount > 0 ? 'Your providers' : 'Connect a provider'}
                  </h1>
                  <p className="mt-1.5 text-[13px] leading-5 text-slate-400">
                    {configuredCount > 0
                      ? 'Manage your accounts or continue to chat.'
                      : 'Choose a provider to start using models in Kordi.'}
                  </p>
                </div>

                {configuredCount > 0 && onEnterChat ? (
                  <Button
                    type="button"
                    className="h-9 shrink-0 rounded-lg px-4 text-[12px]"
                    onClick={continueChat}
                  >
                    Continue to chat
                  </Button>
                ) : onDismissGate ? (
                  <Button
                    type="button"
                    variant="quiet"
                    className="h-9 shrink-0 rounded-lg px-3 text-[12px]"
                    onClick={onDismissGate}
                  >
                    Skip for now
                  </Button>
                ) : null}
              </div>

              {content}
            </div>
          </div>
        )
      ) : (
        <div className="app-auth-settings-page flex h-full min-h-0 w-full flex-col overflow-hidden" style={{ WebkitAppRegion: 'no-drag' as const }}>
          {showSettingsHeader && !showDetailPage ? (
            <div className="mb-5 shrink-0">
              <div className="text-[18px] font-semibold tracking-tight text-white">Authentication</div>
            </div>
          ) : null}

          {settingsDetailContent}
        </div>
      )}
    </div>
  );
}
