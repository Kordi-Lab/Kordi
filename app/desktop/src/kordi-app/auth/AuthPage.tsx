import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Shield } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { DesktopAuthProvider, DesktopAuthState } from '@/kordi-app/types';
import { AuthProviderDetail } from './AuthProviderDetail';
import { AuthProviderList } from './AuthProviderList';
import { buildAuthDisplayProviders, normalizeSelectedProviderId } from './model';

type AuthRoute =
  | { type: 'list' }
  | { type: 'detail'; providerId: string };

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
};

function AuthNavigationControls({
  canGoBack,
  canGoForward,
  onBack,
  onForward,
}: {
  canGoBack: boolean;
  canGoForward: boolean;
  onBack: () => void;
  onForward: () => void;
}) {
  return (
    <div className="inline-flex items-center overflow-hidden rounded-[20px] border border-white/8 bg-white/[0.04] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
      <button
        type="button"
        aria-label="Go back"
        disabled={!canGoBack}
        onClick={onBack}
        className={cn(
          'grid h-9 w-11 place-items-center text-slate-300 transition',
          canGoBack ? 'hover:bg-white/[0.06] hover:text-white' : 'cursor-not-allowed text-slate-600',
        )}
      >
        <ChevronLeft className="h-[18px] w-[18px]" />
      </button>
      <div className="h-6 w-px bg-white/10" />
      <button
        type="button"
        aria-label="Go forward"
        disabled={!canGoForward}
        onClick={onForward}
        className={cn(
          'grid h-9 w-11 place-items-center text-slate-300 transition',
          canGoForward ? 'hover:bg-white/[0.06] hover:text-white' : 'cursor-not-allowed text-slate-600',
        )}
      >
        <ChevronRight className="h-[18px] w-[18px]" />
      </button>
    </div>
  );
}

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
}: AuthPageProps) {
  const showHero = variant === 'gate';
  const showNativeNote = !isNativeShell && variant === 'settings';
  const visibleProviders = buildAuthDisplayProviders(authState);
  const configuredCount = visibleProviders.filter((item) => item.configured).length;
  const useSplitHero = showHero ? layoutWidth >= 1180 : layoutWidth >= 1120;

  const [routeState, setRouteState] = useState<{ history: AuthRoute[]; index: number }>({
    history: [{ type: 'list' }],
    index: 0,
  });

  const currentRoute = routeState.history[routeState.index] ?? { type: 'list' };
  const detailProviderId =
    currentRoute.type === 'detail'
      ? normalizeSelectedProviderId(currentRoute.providerId)
      : normalizeSelectedProviderId(selectedProviderId);
  const provider =
    visibleProviders.find((item) => item.id === detailProviderId) ??
    visibleProviders.find((item) => item.id === normalizeSelectedProviderId(selectedProviderId)) ??
    visibleProviders[0] ??
    null;

  useEffect(() => {
    if (currentRoute.type !== 'detail') return;
    if (provider) return;

    setRouteState({ history: [{ type: 'list' }], index: 0 });
  }, [currentRoute.type, provider]);

  const openProviderDetail = (providerId: string) => {
    onSelectProvider(providerId);
    setRouteState((current) => ({
      history: [...current.history.slice(0, current.index + 1), { type: 'detail', providerId }],
      index: current.index + 1,
    }));
  };

  const goBack = () => {
    setRouteState((current) => ({
      ...current,
      index: Math.max(0, current.index - 1),
    }));
  };

  const goForward = () => {
    setRouteState((current) => ({
      ...current,
      index: Math.min(current.history.length - 1, current.index + 1),
    }));
  };

  const canGoBack = routeState.index > 0;
  const canGoForward = routeState.index < routeState.history.length - 1;
  const showDetailPage = currentRoute.type === 'detail' && !!provider;

  const content = useMemo(() => {
    if (showNativeNote) {
      return (
        <div className="app-surface-muted rounded-[28px] px-5 py-5 text-sm text-slate-300">
          Native desktop sign-in appears here. Open `pnpm dev:desktop` to test provider login, saved accounts, logout, and browser callback flows.
        </div>
      );
    }

    if (isLoading) {
      return (
        <div className="app-surface-muted rounded-[28px] px-5 py-5 text-sm text-slate-300">
          Loading auth state…
        </div>
      );
    }

    if (!showDetailPage) {
      return (
        <AuthProviderList
          providers={visibleProviders}
          selectedProviderId={provider?.id ?? null}
          configuredCount={configuredCount}
          onSelectProvider={openProviderDetail}
          onRefresh={onRefresh}
        />
      );
    }

    return (
      <AuthProviderDetail
        provider={provider}
        rawProviders={authState?.providers ?? []}
        authPath={authState?.authPath}
        error={error}
        onOpenLogin={onOpenLogin}
        onSelectAuthChoice={onSelectAuthChoice}
        onRemoveAuthProfile={onRemoveAuthProfile}
        onLogoutProvider={onLogoutProvider}
      />
    );
  }, [
    authState?.authPath,
    authState?.providers,
    configuredCount,
    error,
    isLoading,
    onLogoutProvider,
    onOpenLogin,
    onRefresh,
    onSelectAuthChoice,
    onRemoveAuthProfile,
    openProviderDetail,
    provider,
    showDetailPage,
    showNativeNote,
    visibleProviders,
  ]);

  const detailHeader = showDetailPage ? (
    <div className="mb-4 flex items-center gap-3">
      <AuthNavigationControls canGoBack={canGoBack} canGoForward={canGoForward} onBack={goBack} onForward={goForward} />
      {!showHero && provider ? (
        <div className="text-[18px] font-semibold tracking-tight text-white">{provider.label} auth</div>
      ) : null}
    </div>
  ) : null;

  return (
    <div
      className={cn('relative z-10 block min-h-0 w-full min-w-0 max-w-none pointer-events-auto', showHero ? 'h-full' : '')}
      style={
        showHero
          ? { WebkitAppRegion: 'no-drag' as const }
          : {
              width: `${layoutWidth}px`,
              minWidth: `${layoutWidth}px`,
              maxWidth: `${layoutWidth}px`,
              WebkitAppRegion: 'no-drag' as const,
            }
      }
    >
      {showHero ? (
        <div className={cn('grid h-full min-h-0 w-full', useSplitHero ? 'grid-cols-[minmax(0,1.02fr)_minmax(420px,640px)]' : 'gap-4')}>
          <div
            className={cn(
              'flex min-h-0 flex-col justify-between bg-[linear-gradient(150deg,rgba(126,111,64,0.14),rgba(24,26,20,0.18)_52%,rgba(12,13,14,0.08))] px-8 py-10 text-white',
              useSplitHero ? 'border-r border-white/8' : 'rounded-[28px] border border-white/8',
            )}
          >
            <div className="max-w-[560px]">
              <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] uppercase tracking-[0.22em] text-slate-300">
                <Shield className="h-3.5 w-3.5" />
                Runtime access
              </div>

              <h1 className="max-w-[13ch] text-[36px] font-semibold leading-[1.02] tracking-[-0.03em] text-white">
                Connect one provider before your first chat.
              </h1>

              <p className="mt-4 max-w-[48ch] text-[15px] leading-7 text-slate-300">
                Pick the provider you want to use, then choose browser sign-in or an API key. One working connection is enough to get started.
              </p>

              <div className="mt-8 grid gap-3 sm:grid-cols-2">
                <div className="app-surface-muted rounded-[24px] px-4 py-4">
                  <div className="text-sm font-medium text-white">Shared sign-in store</div>
                  <div className="mt-2 break-all text-[13px] leading-6 text-slate-400">Desktop and terminal sessions reuse this path: {authState?.authPath ?? 'Loading…'}</div>
                </div>
                <div className="app-surface-muted rounded-[24px] px-4 py-4">
                  <div className="text-sm font-medium text-white">Ready to use</div>
                  <div className="mt-2 text-[13px] leading-6 text-slate-400">
                    {configuredCount} provider{configuredCount === 1 ? '' : 's'} ready out of {visibleProviders.length}.
                  </div>
                </div>
              </div>
            </div>

            <div className="text-[12px] text-slate-400">You can come back later from Settings → Authentication.</div>
          </div>

          <div
            className="min-h-0 min-w-0 border border-white/8 bg-[linear-gradient(180deg,rgba(33,31,34,0.92),rgba(24,23,25,0.96))] p-5"
            style={{ WebkitAppRegion: 'no-drag' as const }}
          >
            {detailHeader}
            <div className="flex min-h-0 min-w-0 w-full max-w-none flex-col" style={{ width: '100%', maxWidth: '100%' }}>{content}</div>
          </div>
        </div>
      ) : (
        <div className="app-auth-settings-page w-full" style={{ WebkitAppRegion: 'no-drag' as const }}>
          {!showDetailPage && (
            <div className="mb-5">
              <div className="text-[18px] font-semibold tracking-tight text-white">Authentication</div>
              <div className="mt-2 max-w-2xl text-[13px] leading-5 text-slate-400">
                Connect Kordi to model providers, manage saved accounts and keys, and switch which access method is active.
              </div>
            </div>
          )}

          {detailHeader}
          <div className="flex w-full min-w-0 max-w-none flex-col" style={{ width: '100%', maxWidth: '100%' }}>{content}</div>
        </div>
      )}
    </div>
  );
}
