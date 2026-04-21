import { useRef, useState } from 'react';
import type { ButtonHTMLAttributes, CSSProperties, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { cn } from '@/lib/utils';
import type { DesktopAuthProvider } from '@/kordi-app/types';
import type { AuthDisplayProvider } from './model';

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
};

function findRawProvider(rawProviders: DesktopAuthProvider[], providerId: string) {
  return rawProviders.find((item) => item.id === providerId) ?? null;
}

function signInMethodButtonLabel(providerId: string, mode: 'oauth' | 'api-key', hasOptions: boolean) {
  if (providerId === 'anthropic' && mode === 'api-key') {
    return hasOptions ? 'Add another API key' : 'Add API key';
  }
  if (hasOptions) {
    return mode === 'oauth' ? 'Re-auth / add account' : 'Add another key';
  }
  return mode === 'oauth' ? 'Sign in' : 'Add key';
}

function DetailSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="app-auth-detail-section overflow-hidden rounded-[20px] border border-white/8 bg-black/10 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
      <div className="border-b border-white/8 px-4 py-2 text-[11px] font-medium uppercase tracking-[0.08em] text-slate-400">{title}</div>
      <div>{children}</div>
    </section>
  );
}

function DetailRow({
  title,
  meta,
  detail,
  trailing,
  multiline = false,
}: {
  title: ReactNode;
  meta?: ReactNode;
  detail?: ReactNode;
  trailing?: ReactNode;
  multiline?: boolean;
}) {
  return (
    <div
      className={cn(
        'grid items-center gap-3 px-4 py-2.5 sm:grid-cols-[minmax(0,1fr)_auto]',
        multiline && 'sm:items-start',
      )}
    >
      <div className="min-w-0">
        <div className="text-[13px] font-medium text-white">{title}</div>
        {meta && <div className="mt-1 text-[11px] leading-5 text-slate-500">{meta}</div>}
        {detail && <div className="mt-1 text-[11px] leading-5 text-slate-400">{detail}</div>}
      </div>
      {trailing && <div className="relative z-10 flex flex-wrap items-center gap-1.5 pointer-events-auto sm:justify-end">{trailing}</div>}
    </div>
  );
}

function SectionDivider() {
  return <div className="mx-4 h-px bg-white/8" />;
}

function formatAuthTimestamp(timestampMs?: number | null) {
  if (!timestampMs) return null;

  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(timestampMs));
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

function stopEventPropagation(event: { stopPropagation: () => void }) {
  event.stopPropagation();
}

const nonDragStyle: CSSProperties = { WebkitAppRegion: 'no-drag' as const };

type AuthActionButtonProps = ButtonHTMLAttributes<HTMLButtonElement>;

const authButtonBaseClass =
  'inline-flex h-8.5 items-center justify-center gap-2 whitespace-nowrap rounded-full px-3.5 text-[12px] font-medium tracking-[-0.01em] transition-all duration-150 disabled:pointer-events-none disabled:opacity-50 cursor-pointer';

const authButtonNeutralClass =
  'border border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.065),rgba(255,255,255,0.035))] text-slate-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.05),0_10px_24px_rgba(0,0,0,0.16)] hover:border-white/14 hover:bg-[linear-gradient(180deg,rgba(255,255,255,0.085),rgba(255,255,255,0.05))]';

const authButtonDangerClass =
  'border border-rose-400/20 bg-[linear-gradient(180deg,rgba(244,63,94,0.16),rgba(190,24,93,0.12))] text-rose-50 shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_10px_24px_rgba(0,0,0,0.16)] hover:border-rose-300/28 hover:bg-[linear-gradient(180deg,rgba(244,63,94,0.22),rgba(190,24,93,0.16))]';

const authActiveBadgeClass =
  'inline-flex h-8.5 items-center justify-center rounded-full border border-violet-400/26 bg-[linear-gradient(180deg,rgba(139,92,246,0.22),rgba(91,33,182,0.16))] px-3.5 text-[12px] font-medium tracking-[-0.01em] text-violet-50 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]';

function AuthActionButton({
  className,
  style,
  onClick,
  onMouseDown,
  onMouseUp,
  onPointerDown,
  onPointerUp,
  type = 'button',
  ...props
}: AuthActionButtonProps) {
  const lastPressAtRef = useRef(0);

  const triggerPress = (
    event: ReactMouseEvent<HTMLButtonElement> | ReactPointerEvent<HTMLButtonElement>,
  ) => {
    if (props.disabled) return;
    const now = Date.now();
    if (now - lastPressAtRef.current < 250) return;
    lastPressAtRef.current = now;
    onClick?.(event as unknown as ReactMouseEvent<HTMLButtonElement>);
  };

  return (
    <button
      {...props}
      type={type}
      onClick={(event) => {
        stopEventPropagation(event);
        triggerPress(event);
      }}
      className={cn(
        authButtonBaseClass,
        className,
      )}
      style={{ ...nonDragStyle, ...style }}
      onMouseDown={(event) => {
        stopEventPropagation(event);
        onMouseDown?.(event);
      }}
      onMouseUp={(event) => {
        stopEventPropagation(event);
        onMouseUp?.(event);
        triggerPress(event);
      }}
      onPointerDown={(event) => {
        stopEventPropagation(event);
        onPointerDown?.(event);
      }}
      onPointerUp={(event) => {
        stopEventPropagation(event);
        onPointerUp?.(event);
        triggerPress(event);
      }}
    />
  );
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
}: AuthProviderDetailProps) {
  const [pendingDeleteProfileId, setPendingDeleteProfileId] = useState<string | null>(null);
  const [pendingDeleteProviderId, setPendingDeleteProviderId] = useState<string | null>(null);
  const [confirmRemoveAll, setConfirmRemoveAll] = useState(false);

  if (!provider) {
    return (
      <div className="app-surface-muted rounded-[24px] px-5 py-5 text-sm text-slate-300">
        No provider selected yet.
      </div>
    );
  }

  const hasSavedProfiles = provider.methods.some((method) => method.options.some((option) => !!option.profileId));

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
      className="relative z-10 block min-h-0 w-full min-w-0 max-w-none self-stretch pointer-events-auto"
      style={{ width: '100%', maxWidth: '100%', WebkitAppRegion: 'no-drag' as const }}
    >
      <div className="grid min-h-0 w-full gap-3.5">
      {error && (
        <div className="rounded-2xl border border-rose-400/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
          {error}
        </div>
      )}

      <DetailSection title="Overview">
        <DetailRow title="Authentication status" detail={provider.statusSummary} />
        {provider.id === 'github-copilot' && (
          <>
            <SectionDivider />
            <DetailRow title="Current host" detail={provider.authority || 'github.com'} />
          </>
        )}
      </DetailSection>

      <DetailSection title="Sign-in methods">
        {provider.id === 'github-copilot' ? (
          (() => {
            const raw = findRawProvider(rawProviders, 'github-copilot');
            if (!raw) return null;

            return (
              <>
                <DetailRow
                  title="GitHub.com"
                  detail="Use the standard GitHub Copilot sign-in flow."
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
                  title="GitHub Enterprise Server"
                  detail={provider.authority ? `Current host: ${provider.authority}` : 'Choose your GitHub Enterprise host and start sign-in.'}
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
                      Configure & sign in
                    </AuthActionButton>
                  }
                />
              </>
            );
          })()
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

      <DetailSection title="Saved profiles">
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
                              onClick={() => requestDeleteProfile(option.providerId, option.profileId)}
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
                No saved {method.mode === 'oauth' ? 'OAuth' : 'API key'} profiles yet.
              </div>
            )}
          </div>
        ))}
      </DetailSection>

      <DetailSection title="Advanced">
        <DetailRow title="Shared runtime path" detail={<span className="break-all">{authPath ?? 'Loading…'}</span>} multiline />
        <SectionDivider />
        <DetailRow
          title="Remove saved authentication"
          detail="Delete saved credentials for this provider from the shared auth store. Environment variables are not removed here."
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
                Remove all saved auth
              </AuthActionButton>
            )
          }
          multiline
        />
      </DetailSection>
      </div>
    </div>
  );
}
