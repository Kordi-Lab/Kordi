import { lazy, Suspense, useState } from 'react';
import type { DesktopAuthProvider } from '@/kordi-app/types';
import type { CloudProviderAuthSnapshotInput, CloudProviderRouteTestInput, CloudProviderRouteTestResult } from '@/features/cloud/cloudAgentRuntimeTypes';
import type { ProviderLoginClient, ProviderLoginSnapshot } from '@/features/cloud/providerLogin';
import type { LoginCallbackCapture } from '@/features/cloud/loginCallbackCapture';
import { SettingsRow, SettingsSection } from '@/kordi-app/components/settingsLayout';
import type { AuthDisplayMethod, AuthDisplayProvider } from './model';
import { OMP_UNAVAILABLE_MESSAGE } from '@/features/cloud/ompAvailability';
import {
  AuthActionButton,
  AuthPageNotice,
  authButtonDangerClass,
  authButtonNeutralClass,
} from './AuthDetailPrimitives';
import { addMethodsSummary, buildAddMethods, resolveAddMethod, type AuthAddMethod, type AuthAddRoute } from './authAddMethods';
import { AuthCustomApiSetup } from './AuthCustomApiSetup';
import { customApiAccounts } from './customApiAccount';
import { AuthRouteTest } from './AuthRouteTest';
import { AuthSavedAccounts } from './AuthSavedAccounts';
import { LocalProviderSetup, localProviderEndpoint } from './LocalProviderSetup';

type AuthDisplayOption = AuthDisplayMethod['options'][number];

// The login page and its session driver load when a method is opened.
const AuthLoginPage = lazy(() => import('./AuthLoginPage').then((module) => ({ default: module.AuthLoginPage })));

type AuthProviderDetailProps = {
  provider: AuthDisplayProvider | null;
  rawProviders: DesktopAuthProvider[];
  authPath?: string;
  error: string | null;
  onOpenLogin: (
    provider: DesktopAuthProvider,
    mode: 'oauth' | 'api-key',
    options?: { authority?: string; requireAuthority?: boolean },
  ) => void;
  onSelectAuthChoice: (providerId: string, choice: string) => void;
  onRemoveAuthProfile: (providerId: string, profileId: string) => void;
  onLogoutProvider: (providerId: string) => void;
  onRefreshAuth: () => void | Promise<void>;
  onDismissGate?: () => void;
  onEnterChat?: (preferredModelValue?: string) => void | Promise<void>;
  onTestRoute?: (input: CloudProviderRouteTestInput) => Promise<CloudProviderRouteTestResult>;
  onValidateCloudKey?: (providerId: string, apiKey: string) => Promise<{ verified: boolean }>;
  onSaveCloudKey?: (input: CloudProviderAuthSnapshotInput) => Promise<void>;
  /** Hosted OMP sign-in sessions; without one only on-this-Mac methods work. */
  loginClient?: ProviderLoginClient | null;
  /** Receives a browser sign-in's localhost redirect on this Mac. */
  loginCallbackCapture?: LoginCallbackCapture | null;
  openExternal?: (url: string) => void;
  onLoginCompleted?: (snapshot: ProviderLoginSnapshot) => void;
  /** A Custom API account was saved; the page returns to the provider with it highlighted. */
  onAccountAdded?: (authChoice: string) => void;
  /** Opens a chat with the active account; offered when a sign-in completes. */
  onStartChat?: () => void;
  /** Add-account layer: absent for the provider page, `{}` for the method picker, a method for its login page. */
  addRoute?: AuthAddRoute | null;
  onAddRouteChange?: (route: AuthAddRoute | null) => void;
  /** Auth choices added in this visit, shown with a brief "Added" badge. */
  recentlyAdded?: string[];
  /** Auth choices whose hosted copy needs the owner to sign in again. */
  needsReconnect?: string[];
  /** The backend has no OMP yet: saved accounts work, OMP actions are off. */
  ompUnavailable?: boolean;
  onOmpUnavailable?: () => void;
};

/** The placeholder doubles as the default name, so an empty field still saves a clear label. */
function suggestedAccountName(provider: AuthDisplayProvider) {
  const used = new Set(provider.methods.flatMap((method) => method.options.map((option) => option.label)));
  const count = provider.methods.reduce((total, method) => total + method.options.length, 0);
  return ['Work', 'Personal'].find((name) => !used.has(name)) ?? `Account ${count + 1}`;
}

export function AuthProviderDetail({
  provider,
  rawProviders,
  authPath: _authPath,
  error,
  onOpenLogin,
  onSelectAuthChoice,
  onRemoveAuthProfile,
  onLogoutProvider,
  onRefreshAuth,
  onDismissGate,
  onEnterChat,
  onTestRoute,
  onValidateCloudKey,
  onSaveCloudKey,
  loginClient = null,
  loginCallbackCapture = null,
  openExternal,
  onLoginCompleted,
  onAccountAdded,
  onStartChat,
  addRoute = null,
  onAddRouteChange,
  recentlyAdded = [],
  needsReconnect = [],
  ompUnavailable = false,
  onOmpUnavailable,
}: AuthProviderDetailProps) {
  const [confirmRemoveAll, setConfirmRemoveAll] = useState(false);
  const [localRoute, setLocalRoute] = useState<AuthAddRoute | null>(null);

  if (!provider) {
    return (
      <div className="app-surface-muted rounded-[24px] px-5 py-5 text-sm text-slate-300">
        Pick a provider to choose how Kordi should sign in.
      </div>
    );
  }

  const hasSavedProfiles = provider.methods.some((method) => method.options.some((option) => !!option.profileId));
  const hasLocalSavedProfiles = provider.methods.some((method) => method.options.some((option) => !!option.profileId && option.source !== 'Cloud'));
  const localEndpoint = localProviderEndpoint(provider);
  const isLocalModelControl = (provider.id === 'lm-studio' || provider.id === 'ollama') && !!localEndpoint;
  const openUrl = openExternal ?? ((url: string) => { window.open(url, '_blank', 'noopener,noreferrer'); });
  const addMethods = buildAddMethods(provider, rawProviders);
  // The page owner normally holds the route so its header can follow the layer.
  const route = onAddRouteChange ? addRoute : localRoute;
  const navigate = (next: AuthAddRoute | null) => (onAddRouteChange ? onAddRouteChange(next) : setLocalRoute(next));
  const choose = (method: AuthAddMethod) => {
    if (method.kind === 'local' && method.raw && method.nativeMode) {
      navigate(null);
      onOpenLogin(method.raw, method.nativeMode);
      return;
    }
    navigate({ method: method.key });
  };

  // Reconnect signs in again with the method that created the account.
  const reconnect = (option: AuthDisplayOption, method: AuthDisplayMethod) => {
    const raw = rawProviders.find((item) => item.id === option.providerId);
    if (option.source !== 'Cloud' && raw) {
      onOpenLogin(raw, method.mode);
      return;
    }
    const match = addMethods.find((item) => item.method?.providerId === method.providerId && item.hosted
      && (method.mode === 'api-key' ? item.kind === 'api-key' : item.kind !== 'api-key'));
    navigate(match ? { method: match.key } : {});
  };

  const notice = ompUnavailable ? <AuthPageNotice>{OMP_UNAVAILABLE_MESSAGE}</AuthPageNotice> : null;
  const omp = { ompUnavailable, onOmpUnavailable };

  // Layer 3: one method's login page. Layer 2: the method picker.
  if (route && !isLocalModelControl) {
    const method = resolveAddMethod(addMethods, route);
    const back = () => navigate(addMethods.length > 1 && route.method ? {} : null);
    if (method?.kind === 'custom') {
      const editing = route.account ? customApiAccounts(provider).find((account) => account.authChoice === route.account) ?? null : null;
      return (
        <div className="grid min-h-0 w-full pb-6 pt-6">
          {notice}
          <AuthCustomApiSetup
            key={editing?.authChoice ?? 'new'}
            account={editing}
            onValidateCloudKey={onValidateCloudKey}
            onSaveCloudKey={onSaveCloudKey}
            onSaved={(authChoice, { edited }) => { if (!edited) onAccountAdded?.(authChoice); navigate(null); }}
            disabledReason={ompUnavailable ? OMP_UNAVAILABLE_MESSAGE : null}
          />
        </div>
      );
    }
    if (method?.hosted) {
      return (
        <Suspense fallback={<p className="m-0 pt-6 text-[12px] text-slate-500">Loading sign-in…</p>}>
        <AuthLoginPage
          key={method.key}
          {...omp}
          method={method}
          suggestedAccountName={suggestedAccountName(provider)}
          client={loginClient}
          callbackCapture={loginCallbackCapture}
          openExternal={openUrl}
          onBack={back}
          onDone={() => navigate(null)}
          onStartChat={onStartChat}
          onCompleted={(snapshot) => onLoginCompleted?.(snapshot)}
        />
        </Suspense>
      );
    }
    return (
      <div className="grid min-h-0 w-full pb-6 pt-6">
        {notice}
        <SettingsSection className="app-auth-detail-section">
          {addMethods.map((method) => (
            <SettingsRow
              key={method.key}
              className="app-auth-add-method-row"
              title={method.title}
              description={method.description}
              chevron
              onClick={() => choose(method)}
            />
          ))}
        </SettingsSection>
      </div>
    );
  }

  return (
    <div
      className="relative z-10 block min-h-0 w-full min-w-0 self-stretch pr-1 pointer-events-auto"
      style={{ WebkitAppRegion: 'no-drag' as const }}
    >
      <div className="grid min-h-0 w-full pb-6 pt-6">
        {error && (
          <div role="alert" className="app-error-text pb-3 text-[12px] leading-5 text-rose-200">
            {error}
          </div>
        )}
        {isLocalModelControl ? null : notice}

        {isLocalModelControl ? (
          <SettingsSection title="Local server" className="app-auth-detail-section">
            <LocalProviderSetup
              provider={provider}
              rawProviders={rawProviders}
              onOpenLogin={onOpenLogin}
              onRefreshAuth={onRefreshAuth}
              onDismissGate={onDismissGate}
              onEnterChat={onEnterChat}
            />
          </SettingsSection>
        ) : (
          <>
            <AuthSavedAccounts
              provider={provider}
              recentlyAdded={recentlyAdded}
              needsReconnect={needsReconnect}
              onReconnect={reconnect}
              onEdit={provider.id === 'custom' && addMethods[0] ? (option) => navigate({ method: addMethods[0].key, account: option.value }) : undefined}
              onSelectAuthChoice={onSelectAuthChoice}
              onRemoveAuthProfile={onRemoveAuthProfile}
            />

            <SettingsSection title={hasSavedProfiles ? undefined : 'Accounts'} className="app-auth-detail-section">
              {addMethods.length > 0 ? (
                <SettingsRow
                  className="app-auth-add-account-row"
                  title="Add account"
                  description={addMethodsSummary(addMethods)}
                  chevron
                  onClick={() => (addMethods.length === 1 ? choose(addMethods[0]) : navigate({}))}
                />
              ) : (
                <SettingsRow title="Not available yet" description="OMP has no sign-in step for this provider that Kordi can show." />
              )}
            </SettingsSection>

            {onTestRoute ? <AuthRouteTest provider={provider} onTestRoute={onTestRoute} disabledReason={ompUnavailable ? OMP_UNAVAILABLE_MESSAGE : null} /> : null}

            {hasSavedProfiles && hasLocalSavedProfiles && !provider.catalogOnly ? (
              <SettingsSection title="Advanced" className="app-auth-detail-section">
                <SettingsRow
                  title="Remove saved access"
                  description="Saved access is reused after relaunch on this device, but is not copied to another device; sign in or add the key there. Delete it from Kordi's shared desktop and terminal auth store here. Environment variables are not removed."
                  control={confirmRemoveAll ? (
                    <>
                      <AuthActionButton
                        type="button"
                        className={authButtonDangerClass}
                        onClick={() => {
                          setConfirmRemoveAll(false);
                          onLogoutProvider(provider.id);
                        }}
                      >
                        Confirm remove all
                      </AuthActionButton>
                      <AuthActionButton type="button" className={authButtonNeutralClass} onClick={() => setConfirmRemoveAll(false)}>
                        Cancel
                      </AuthActionButton>
                    </>
                  ) : (
                    <AuthActionButton type="button" className={authButtonDangerClass} onClick={() => setConfirmRemoveAll(true)}>
                      Remove all saved access
                    </AuthActionButton>
                  )}
                />
              </SettingsSection>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
