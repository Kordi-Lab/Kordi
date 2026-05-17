import { useState } from 'react';
import { CheckCircle2, Circle, Sparkles } from 'lucide-react';
import { formatDesktopDateTime } from '@/lib/time';
import { cn } from '@/lib/utils';
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
  authButtonPrimaryClass,
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

type AuthStep = {
  label: string;
  detail: string;
  state: 'done' | 'active' | 'pending';
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

function methodLabel(mode: 'oauth' | 'api-key') {
  return mode === 'oauth' ? 'Sign-in account' : 'API key';
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

function firstConnectMethod(provider: AuthDisplayProvider, rawProviders: DesktopAuthProvider[]) {
  const preferred = provider.methods.find((method) => method.mode === 'oauth') ?? provider.methods[0] ?? null;
  if (!preferred) return null;
  const raw = findRawProvider(rawProviders, preferred.providerId);
  if (!raw) return null;
  return { method: preferred, raw };
}

function localProviderSteps(provider: AuthDisplayProvider): AuthStep[] {
  return [
    { label: 'Choose provider', detail: provider.label, state: 'done' },
    { label: 'Check local runtime', detail: 'Install, server, and model state', state: provider.configured ? 'done' : 'active' },
    { label: 'Start chat', detail: provider.configured ? 'Ready when you are' : 'Available after a model is running', state: provider.configured ? 'active' : 'pending' },
  ];
}

function StepFlow({ steps }: { steps: AuthStep[] }) {
  return (
    <div className="grid gap-2 sm:grid-cols-3">
      {steps.map((step, index) => (
        <div
          key={step.label}
          className={cn(
            'rounded-[18px] px-3.5 py-3 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.055)]',
            step.state === 'done'
              ? 'bg-emerald-300/[0.055] text-emerald-50'
              : step.state === 'active'
                ? 'bg-white/[0.07] text-white'
                : 'bg-white/[0.03] text-slate-400',
          )}
        >
          <div className="flex items-center gap-2 text-[12px] font-medium">
            {step.state === 'done' ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Circle className="h-3.5 w-3.5" />}
            <span>{index + 1}. {step.label}</span>
          </div>
          <div className="mt-1.5 text-[11px] leading-4 opacity-75">{step.detail}</div>
        </div>
      ))}
    </div>
  );
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
  const hasActiveProfile = provider.methods.some((method) => method.options.some((option) => option.active));
  const localEndpoint = localProviderEndpoint(provider);
  const isLocalModelControl = (provider.id === 'lm-studio' || provider.id === 'ollama') && !!localEndpoint;
  const showCloudEnterChatCta = !isLocalModelControl && Boolean(onEnterChat) && hasActiveProfile;
  const primaryConnect = firstConnectMethod(provider, rawProviders);
  const localRuntimeSteps = isLocalModelControl ? localProviderSteps(provider) : [];

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

  const savedAccessSection = hasSavedProfiles ? (
    <DetailSection title="Saved access">
      {provider.methods.map((method, methodIndex) => (
        <div key={`profiles-${provider.id}-${method.mode}`}>
          {methodIndex > 0 && <SectionDivider />}
          <div className="px-4 pb-1 pt-3 text-[12px] font-medium text-slate-400">
            {methodLabel(method.mode)}
          </div>
          {method.options.map((option, optionIndex) => (
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
                          <AuthActionButton type="button" className={authButtonDangerClass} onClick={confirmDeleteProfile}>
                            Confirm delete
                          </AuthActionButton>
                          <AuthActionButton type="button" className={authButtonNeutralClass} onClick={cancelDeleteProfile}>
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
          ))}
        </div>
      ))}
    </DetailSection>
  ) : null;

  return (
    <div
      className="relative z-10 block min-h-0 w-full min-w-0 max-w-none self-stretch pr-1 pointer-events-auto"
      style={{ width: '100%', maxWidth: '100%', WebkitAppRegion: 'no-drag' as const }}
    >
      <div className="grid min-h-0 w-full gap-3.5 pb-6">
        {error && (
          <div className="rounded-2xl border border-rose-400/24 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
            {error}
          </div>
        )}

        <div className="rounded-[26px] bg-white/[0.045] px-5 py-5 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0 max-w-[38rem]">
              <div className="inline-flex items-center gap-2 rounded-full bg-white/[0.055] px-2.5 py-1 text-[11px] font-medium text-slate-300">
                <Sparkles className="h-3.5 w-3.5" /> {provider.configured ? 'Ready' : 'Setup needed'}
              </div>
              <div className="mt-3 text-[25px] font-semibold leading-8 tracking-[-0.04em] text-white">
                {provider.configured ? `${provider.label} is connected` : `Connect ${provider.label}`}
              </div>
              <div className="mt-2 max-w-[58ch] text-[13px] leading-6 text-slate-300">
                {isLocalModelControl
                  ? 'Check the local app, server, and loaded model before starting chat.'
                  : 'Use the provider account or API key you want Kordi to use for chat.'}
              </div>
            </div>

            <div className="flex shrink-0 flex-wrap justify-end gap-2">
              {provider.configured && onEnterChat ? (
                <AuthActionButton type="button" className={authButtonPrimaryClass} onClick={() => { void onEnterChat(); }}>
                  Enter chat
                </AuthActionButton>
              ) : primaryConnect ? (
                <AuthActionButton
                  type="button"
                  className={authButtonPrimaryClass}
                  onClick={() => onOpenLogin(primaryConnect.raw, primaryConnect.method.mode)}
                >
                  {signInMethodButtonLabel(provider.id, primaryConnect.method.mode, primaryConnect.method.options.length > 0)}
                </AuthActionButton>
              ) : null}
            </div>
          </div>

          {isLocalModelControl ? (
            <div className="mt-5">
              <StepFlow steps={localRuntimeSteps} />
            </div>
          ) : null}
        </div>

        {isLocalModelControl ? (
          <LocalProviderSetup
            provider={provider}
            rawProviders={rawProviders}
            onOpenLogin={onOpenLogin}
            onRefreshAuth={onRefreshAuth}
            onDismissGate={onDismissGate}
            onEnterChat={onEnterChat}
          />
        ) : (
          <>
            <DetailSection title="Connect">
              {provider.methods.map((method, index) => {
                const raw = findRawProvider(rawProviders, method.providerId);
                if (!raw) return null;

                return (
                  <div key={`${provider.id}-${method.mode}`}>
                    {index > 0 && <SectionDivider />}
                    <DetailRow
                      title={method.title}
                      detail={method.detail}
                      multiline
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
              })}
            </DetailSection>

            {savedAccessSection}

            {showCloudEnterChatCta ? (
              <DetailSection title="Start chatting">
                <DetailRow
                  title="Open chat"
                  detail={`Use the active ${provider.label} profile and jump into a new chat.`}
                  multiline
                  trailing={
                    <AuthActionButton
                      type="button"
                      className={authButtonPrimaryClass}
                      onClick={() => { void onEnterChat?.(); }}
                    >
                      Enter chat
                    </AuthActionButton>
                  }
                />
              </DetailSection>
            ) : null}

            {hasSavedProfiles ? (
              <DetailSection title="Advanced">
                <DetailRow
                  title="Remove saved access"
                  detail="Delete saved accounts and keys for this provider from Kordi's shared auth store. Environment variables are not removed here."
                  trailing={
                    confirmRemoveAll ? (
                      <>
                        <AuthActionButton type="button" className={authButtonDangerClass} onClick={handleRemoveAll}>
                          Confirm remove all
                        </AuthActionButton>
                        <AuthActionButton type="button" className={authButtonNeutralClass} onClick={() => setConfirmRemoveAll(false)}>
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
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
