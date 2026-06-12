import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
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
  onDismissGate?: () => void;
  onEnterChat?: (preferredModelValue?: string) => void | Promise<void>;
  showSettingsHeader?: boolean;
  settingsLayoutMode?: 'fixed' | 'fluid';
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
  showSettingsHeader = true,
  settingsLayoutMode = 'fixed',
}: AuthPageProps) {
  const showHero = variant === 'gate';
  const showNativeNote = !isNativeShell && variant === 'settings';
  const visibleProviders = buildAuthDisplayProviders(authState);
  const configuredCount = visibleProviders.filter((item) => item.configured).length;

  const [currentRoute, setCurrentRoute] = useState<AuthRoute>({ type: 'list' });
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

    setCurrentRoute({ type: 'list' });
  }, [currentRoute.type, provider]);

  const openProviderDetail = (providerId: string) => {
    onSelectProvider(providerId);
    setCurrentRoute({ type: 'detail', providerId });
  };

  const goToProviderList = () => {
    setCurrentRoute({ type: 'list' });
  };

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
          onEnterChat={onEnterChat ?? onDismissGate}
          variant={showHero ? 'gate' : 'settings'}
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
        onRefreshAuth={onRefresh}
        onDismissGate={onDismissGate}
        onEnterChat={onEnterChat}
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
    onDismissGate,
    onEnterChat,
    openProviderDetail,
    provider,
    showDetailPage,
    showNativeNote,
    showHero,
    visibleProviders,
  ]);

  const detailHeader = showDetailPage ? (
    <div className="flex shrink-0 items-center gap-3 pb-4">
      <Button
        type="button"
        variant="secondary"
        className="app-control-chip h-9 rounded-full border-0 px-3.5 text-[12px] text-white"
        onClick={goToProviderList}
      >
        <ChevronLeft className="mr-1.5 h-3.5 w-3.5" />
        Back to providers
      </Button>
    </div>
  ) : null;

  const settingsDetailContent = showDetailPage ? (
    <ScrollArea className="min-h-0 flex-1 pr-2">
      <div className="min-h-0 w-full min-w-0 max-w-none" style={{ width: '100%', maxWidth: '100%' }}>{content}</div>
    </ScrollArea>
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
          <div className="app-modal-panel flex h-full min-h-0 w-full justify-center overflow-hidden rounded-[30px] border border-white/10 bg-[linear-gradient(150deg,rgba(37,99,235,0.07),rgba(15,23,42,0.16)_48%,rgba(15,23,42,0.22))] px-5 py-5 shadow-[var(--app-shadow-float)]">
            <div className="flex min-h-0 w-full max-w-[780px] flex-col">
              {detailHeader}
              <ScrollArea className="min-h-0 flex-1 pr-2">
                <div className="min-h-0 w-full">{content}</div>
              </ScrollArea>
            </div>
          </div>
        ) : (
          <div className="app-modal-panel flex h-full min-h-0 w-full items-center justify-center overflow-hidden rounded-[30px] border border-white/10 bg-[linear-gradient(150deg,rgba(37,99,235,0.08),rgba(15,23,42,0.18)_48%,rgba(15,23,42,0.24))] px-8 py-8 shadow-[var(--app-shadow-float)]">
            <div className="flex w-full max-w-[820px] flex-col gap-7">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="max-w-[34rem]">
                  <h1 className="text-[42px] font-semibold leading-[0.98] tracking-[-0.045em] text-white">
                    Connect a provider
                  </h1>
                  <p className="mt-3 max-w-[34ch] text-[15px] leading-6 text-slate-300">
                    Use cloud APIs or local models to start chatting.
                  </p>
                </div>

                {onDismissGate ? (
                  <Button
                    variant="secondary"
                    className="h-9 shrink-0 rounded-full px-4 text-[12px] text-white"
                    onClick={onDismissGate}
                  >
                    Skip for now →
                  </Button>
                ) : null}
              </div>

              <div className="min-h-0">{content}</div>

              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/8 pt-4 text-[12px] text-slate-400">
                <div>Shared authentication enabled</div>
                <div>Details stay in Settings → Authentication.</div>
              </div>
            </div>
          </div>
        )
      ) : (
        <div className="app-auth-settings-page flex h-full min-h-0 w-full flex-col overflow-hidden" style={{ WebkitAppRegion: 'no-drag' as const }}>
          {showSettingsHeader && !showDetailPage ? (
            <div className="mb-5 shrink-0">
              <div className="text-[18px] font-semibold tracking-tight text-white">Authentication</div>
              <div className="mt-2 max-w-2xl text-[13px] leading-5 text-slate-400">
                Connect model providers, manage saved accounts and optional keys, and switch which access method is active.
              </div>
            </div>
          ) : null}

          {detailHeader}
          {settingsDetailContent}
        </div>
      )}
    </div>
  );
}
