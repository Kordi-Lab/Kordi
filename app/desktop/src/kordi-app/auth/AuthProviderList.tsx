import { ChevronRight, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { AuthProviderGlyph } from './AuthProviderGlyph';
import type { AuthDisplayProvider } from './model';
import { providerListSubtitle } from './model';

type AuthProviderListProps = {
  providers: AuthDisplayProvider[];
  selectedProviderId: string | null;
  configuredCount: number;
  onSelectProvider: (providerId: string) => void;
  onRefresh: () => void;
};

export function AuthProviderList({
  providers,
  selectedProviderId,
  configuredCount,
  onSelectProvider,
  onRefresh,
}: AuthProviderListProps) {
  return (
    <div
      className="app-surface-muted app-auth-provider-list flex h-full min-h-0 w-full min-w-0 max-w-none flex-1 flex-col self-stretch overflow-hidden rounded-[24px] border border-white/6 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
      style={{ width: '100%', maxWidth: '100%', WebkitAppRegion: 'no-drag' as const }}
    >
      <div className="mb-2 flex shrink-0 items-start justify-between gap-3 px-2 py-1">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <div className="text-[13px] font-medium text-white">Choose a provider</div>
            <div className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] uppercase tracking-[0.08em] text-slate-300">
              {configuredCount} ready of {providers.length}
            </div>
          </div>
          <div className="mt-1 max-w-[40ch] text-[11px] leading-5 text-slate-400">
            Pick a cloud provider or local model server. LM Studio and Ollama are ready without a saved key once their local servers are running.
          </div>
        </div>
        <Button
          type="button"
          variant="secondary"
          className="app-control-chip h-9 shrink-0 rounded-full border-0 px-3.5 text-[12px]"
          onClick={onRefresh}
          style={{ WebkitAppRegion: 'no-drag' as const, cursor: 'pointer' }}
        >
          <RefreshCw className="mr-2 h-3.5 w-3.5" />
          Refresh
        </Button>
      </div>

      <ScrollArea className="min-h-0 flex-1 pr-1">
        <div className="w-full overflow-hidden rounded-[20px] border border-[color:var(--app-divider)] bg-[color:var(--app-control-bg)] shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
          {providers.map((provider, index) => {
            const selected = provider.id === selectedProviderId;

            return (
              <button
                key={provider.id}
                type="button"
                onClick={() => onSelectProvider(provider.id)}
                className={cn(
                  'app-auth-provider-row flex w-full cursor-pointer items-center gap-3 px-4 py-3.5 text-left transition',
                  selected
                    ? 'bg-white/[0.07] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]'
                    : 'hover:bg-white/[0.035]',
                  index > 0 && 'border-t border-white/8',
                )}
                style={{ WebkitAppRegion: 'no-drag' as const }}
              >
                <AuthProviderGlyph providerId={provider.id} label={provider.label} size="sm" />

                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium text-white/95">{provider.label}</div>
                  <div className="mt-0.5 truncate text-[11px] text-slate-400">{providerListSubtitle(provider)}</div>
                  <div className="mt-1 truncate text-[11px] text-slate-500">{provider.loginHint}</div>
                </div>

                <ChevronRight className={cn('h-4 w-4 shrink-0 text-slate-500 transition', selected && 'text-slate-300')} />
              </button>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}
