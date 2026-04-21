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
      className="app-surface-muted app-auth-provider-list block w-full min-w-0 max-w-none flex-1 self-stretch rounded-[22px] border border-white/6 p-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
      style={{ width: '100%', maxWidth: '100%', WebkitAppRegion: 'no-drag' as const }}
    >
      <div className="mb-1.5 flex items-center justify-between gap-3 px-2.5 py-1.5">
        <div>
          <div className="text-[13px] font-medium text-white">Providers</div>
          <div className="mt-1 text-[11px] text-slate-400">{configuredCount} configured of {providers.length}</div>
        </div>
        <Button
          type="button"
          variant="secondary"
          className="app-control-chip rounded-xl border-0 px-3 text-[12px]"
          onClick={onRefresh}
          style={{ WebkitAppRegion: 'no-drag' as const, cursor: 'pointer' }}
        >
          <RefreshCw className="mr-2 h-3.5 w-3.5" />
          Refresh
        </Button>
      </div>

      <ScrollArea className="min-h-0 flex-1 pr-1">
        <div className="w-full overflow-hidden rounded-[18px] border border-white/7 bg-black/12 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
          {providers.map((provider, index) => {
            const selected = provider.id === selectedProviderId;

            return (
              <button
                key={provider.id}
                type="button"
                onClick={() => onSelectProvider(provider.id)}
                className={cn(
                  'app-auth-provider-row flex w-full cursor-pointer items-center gap-3 px-3.5 py-3 text-left transition',
                  selected
                    ? 'bg-white/[0.065] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]'
                    : 'hover:bg-white/[0.035]',
                  index > 0 && 'border-t border-white/8',
                )}
                style={{ WebkitAppRegion: 'no-drag' as const }}
              >
                <AuthProviderGlyph providerId={provider.id} label={provider.label} size="sm" />

                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium text-white/95">{provider.label}</div>
                  <div className="truncate text-[11px] text-slate-400">{providerListSubtitle(provider)}</div>
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
