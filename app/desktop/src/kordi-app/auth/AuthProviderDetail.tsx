import { useState } from 'react';
import { formatDesktopDateTime } from '@/lib/time';
import type { DesktopAuthProvider } from '@/kordi-app/types';
import type { AuthDisplayProvider } from './model';
import {
  AuthActionButton,
  DetailRow,
  DetailSection,
  SectionDivider,
  authActiveBadgeClass,
  authButtonDangerClass,
  authButtonNeutralClass,
} from './AuthDetailPrimitives';
import { LocalProviderSetup, localProviderEndpoint } from './LocalProviderSetup';

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
};

function findRawProvider(rawProviders: DesktopAuthProvider[], providerId: string) {
  return rawProviders.find((item) => item.id === providerId) ?? null;
}

function signInMethodButtonLabel(providerId: string, mode: 'oauth' | 'api-key', hasOptions: boolean) {
  if ((providerId === 'lm-studio' || providerId === 'ollama') && mode === 'api-key') {
    return hasOptions ? 'Add another optional key' : 'Save optional key';
  }
  if (providerId === 'anthropic' && mode === 'api-key') {
    return hasOptions ? 'Add another API key' : 'Add API key';
  }
  if (hasOptions) {
    return mode === 'oauth' ? 'Add another account' : 'Add another key';
  }
  return mode === 'oauth' ? 'Sign in' : 'Add key';
}

function formatAuthTimestamp(timestampMs?: number | null) {
  if (!timestampMs) return null;

  try {
    return formatDesktopDateTime(timestampMs);
  } catch {
    return null;
  }
}

function buildProfileMeta(option: {
  configuredAtMs?: number | null;
  updatedAtMs?: number | null;
}) {
  const configured = formatAuthTimestamp(option.configuredAtMs);
  const updated = formatAuthTimestamp(option.updatedAtMs);

  if (!configured && !updated) return undefined;

  return [
    configured ? `Added: ${configured}` : null,
    updated ? `Last active: ${updated}` : null,
  ]
    .filter(Boolean)
    .join(' • ');
}

export function AuthProviderDetail({
  provider,
  rawProviders,
  authPath,
  error,
  onOpenLogin,
  onSelectAuthChoice,
  onRemoveAuthProfile,
  onLogoutProvider,
  onRefreshAuth,
  onDismissGate,
  onEnterChat,
}: AuthProviderDetailProps) {
  const [pendingDeleteProfileId, setPendingDeleteProfileId] = useState<string | null>(null);
  const [pendingDeleteProviderId, setPendingDeleteProviderId] = useState<string | null>(null);
  const [confirmRemoveAll, setConfirmRemoveAll] = useState(false);

  if (!provider) {
    return (
      <div className="app-surface-muted rounded-[24px] px-5 py-5 text-sm text-slate-300">
        Pick a provider to choose how Kordi should sign in.
      </div>
    );
  }

  const hasSavedProfiles = provider.methods.some((method) => method.options.some((option) => !!option.profileId));
  const localEndpoint = localProviderEndpoint(provider);
  const isLmStudioLocal = provider.id === 'lm-studio' && !!localEndpoint;

  const handleRemoveAll = () => {
    if (!hasSavedProfiles) return;
    setConfirmRemoveAll(false);
    onLogoutProvider(provider.id);
  };

  const requestDeleteProfile = (providerId: string, profileId: string) => {
    setConfirmRemoveAll(false);
    setPendingDeleteProviderId(providerId);
    setPendingDeleteProfileId(profileId);
  };

  const confirmDeleteProfile = () => {
    if (!pendingDeleteProviderId || !pendingDeleteProfileId) return;
    const providerId = pendingDeleteProviderId;
    const profileId = pendingDeleteProfileId;
    setPendingDeleteProviderId(null);
    setPendingDeleteProfileId(null);
    onRemoveAuthProfile(providerId, profileId);
  };

  const cancelDeleteProfile = () => {
    setPendingDeleteProviderId(null);
    setPendingDeleteProfileId(null);
  };

  return (
    <div
      className="relative z-10 block h-full min-h-0 w-full min-w-0 max-w-none self-stretch overflow-y-auto pr-1 pointer-events-auto"
      style={{ width: '100%', maxWidth: '100%', WebkitAppRegion: 'no-drag' as const }}
    >
      <div className="grid min-h-0 w-full gap-3.5">
      {error && (
        <div className="rounded-2xl border border-rose-400/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
          {error}
        </div>
      )}

      <DetailSection title="What this provider is for">
        <DetailRow title="Best for" detail={provider.loginHint} multiline />
        <SectionDivider />
        <DetailRow title="Saved access" detail={provider.statusSummary} multiline />
        {provider.id === 'github-copilot' && (
          <>
            <SectionDivider />
            <DetailRow title="Current GitHub host" detail={provider.authority || 'github.com'} />
          </>
        )}
        {localEndpoint && (
          <>
            <SectionDivider />
            <DetailRow
              title="Local OpenAI-compatible endpoint"
              detail={<span className="break-all font-mono text-[11px] text-slate-300">{localEndpoint}</span>}
              multiline
            />
          </>
        )}
      </DetailSection>

      <DetailSection title={isLmStudioLocal ? 'Local model control center' : localEndpoint ? 'Local server setup' : 'Ways to connect'}>
        {provider.id === 'github-copilot' ? (
          (() => {
            const raw = findRawProvider(rawProviders, 'github-copilot');
            if (!raw) return null;

            return (
              <>
                <DetailRow
                  title="GitHub.com"
                  detail="Use the standard GitHub sign-in flow for personal or team accounts on github.com."
                  trailing={
                    <AuthActionButton
                      type="button"
                      className={authButtonNeutralClass}
                      onClick={() => onOpenLogin(raw, 'oauth', { authority: 'github.com' })}
                    >
                      Sign in
                    </AuthActionButton>
                  }
                />
                <SectionDivider />
                <DetailRow
                  title="GitHub Enterprise host"
                  detail={provider.authority ? `Current host: ${provider.authority}` : 'Choose your GitHub Enterprise host, then start sign-in.'}
                  trailing={
                    <AuthActionButton
                      type="button"
                      className={authButtonNeutralClass}
                      onClick={() =>
                        onOpenLogin(raw, 'oauth', {
                          authority: provider.authority ?? '',
                          requireAuthority: true,
                        })
                      }
                    >
                      Choose host & sign in
                    </AuthActionButton>
                  }
                />
              </>
            );
          })()
        ) : localEndpoint ? (
          <LocalProviderSetup
            provider={provider}
            rawProviders={rawProviders}
            onOpenLogin={onOpenLogin}
            onRefreshAuth={onRefreshAuth}
            onDismissGate={onDismissGate}
            onEnterChat={onEnterChat}
          />
        ) : (
          provider.methods.map((method, index) => {
            const raw = findRawProvider(rawProviders, method.providerId);
            if (!raw) return null;

            return (
              <div key={`${provider.id}-${method.mode}`}>
                {index > 0 && <SectionDivider />}
                <DetailRow
                  title={method.title}
                  detail={method.detail}
                  trailing={
                    <AuthActionButton
                      type="button"
                      className={authButtonNeutralClass}
                      onClick={() => onOpenLogin(raw, method.mode)}
                    >
                      {signInMethodButtonLabel(provider.id, method.mode, method.options.length > 0)}
                    </AuthActionButton>
                  }
                />
              </div>
            );
          })
        )}
      </DetailSection>

      {!isLmStudioLocal ? (
        <>
          <DetailSection title="Saved accounts and keys">
            {provider.methods.map((method, methodIndex) => (
              <div key={`profiles-${provider.id}-${method.mode}`}>
                {methodIndex > 0 && <SectionDivider />}
                <div className="px-4 pb-1 pt-2 text-[10px] font-medium uppercase tracking-[0.14em] text-slate-500">
                  {method.mode === 'oauth' ? 'OAuth' : 'API key'}
                </div>
                {method.options.length > 0 ? (
                  method.options.map((option, optionIndex) => (
                    <div key={`${method.providerId}-${option.value}`}>
                      {optionIndex > 0 && <SectionDivider />}
                      <DetailRow
                        title={option.label}
                        meta={buildProfileMeta(option)}
                        detail={option.detail}
                        multiline
                        trailing={
                          <>
                            {option.active ? (
                              <div className={authActiveBadgeClass}>Active</div>
                            ) : (
                              <AuthActionButton
                                type="button"
                                className={authButtonNeutralClass}
                                onClick={() => onSelectAuthChoice(option.providerId, option.value)}
                              >
                                {option.profileId ? 'Use this profile' : 'Use environment'}
                              </AuthActionButton>
                            )}
                            {option.profileId ? (
                              pendingDeleteProfileId === option.profileId && pendingDeleteProviderId === option.providerId ? (
                                <>
                                  <AuthActionButton
                                    type="button"
                                    className={authButtonDangerClass}
                                    onClick={confirmDeleteProfile}
                                  >
                                    Confirm delete
                                  </AuthActionButton>
                                  <AuthActionButton
                                    type="button"
                                    className={authButtonNeutralClass}
                                    onClick={cancelDeleteProfile}
                                  >
                                    Cancel
                                  </AuthActionButton>
                                </>
                              ) : (
                                <AuthActionButton
                                  type="button"
                                  className={authButtonDangerClass}
                                  onClick={() => requestDeleteProfile(option.providerId, option.profileId!)}
                                >
                                  Delete
                                </AuthActionButton>
                              )
                            ) : (
                              <div className="app-badge-neutral rounded-full px-2.5 py-0.5 text-[10px] leading-none">Environment</div>
                            )}
                          </>
                        }
                      />
                    </div>
                  ))
                ) : (
                  <div className="px-4 pb-3 pt-2 text-[11px] leading-5 text-slate-400">
                    {localEndpoint && method.mode === 'api-key'
                      ? 'No saved key needed for the default local server.'
                      : `No saved ${method.mode === 'oauth' ? 'sign-in accounts' : 'API keys'} yet.`}
                  </div>
                )}
              </div>
            ))}
          </DetailSection>

          <DetailSection title="Storage and cleanup">
            <DetailRow title="Shared auth store" detail={<span className="break-all">{authPath ?? 'Loading…'}</span>} multiline />
            <SectionDivider />
            <DetailRow
              title="Remove saved access"
              detail={localEndpoint
                ? 'Delete optional saved API keys for this local provider from Kordi\'s shared auth store. The local endpoint itself is not changed.'
                : 'Delete saved accounts and keys for this provider from Kordi\'s shared auth store. Environment variables are not removed here.'}
              trailing={
                confirmRemoveAll ? (
                  <>
                    <AuthActionButton
                      type="button"
                      className={authButtonDangerClass}
                      onClick={handleRemoveAll}
                    >
                      Confirm remove all
                    </AuthActionButton>
                    <AuthActionButton
                      type="button"
                      className={authButtonNeutralClass}
                      onClick={() => setConfirmRemoveAll(false)}
                    >
                      Cancel
                    </AuthActionButton>
                  </>
                ) : (
                  <AuthActionButton
                    type="button"
                    className={authButtonDangerClass}
                    onClick={() => {
                      setPendingDeleteProviderId(null);
                      setPendingDeleteProfileId(null);
                      setConfirmRemoveAll(true);
                    }}
                    disabled={!hasSavedProfiles}
                  >
                    Remove all saved access
                  </AuthActionButton>
                )
              }
              multiline
            />
          </DetailSection>
        </>
      ) : null}
      </div>
    </div>
  );
}
