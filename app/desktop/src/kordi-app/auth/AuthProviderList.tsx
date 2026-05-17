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
  onEnterChat?: (preferredModelValue?: string) => void | Promise<void>;
  variant?: 'settings' | 'gate';
};

const GATE_PROVIDER_SUBTITLES: Record<string, string> = {
  openai: 'ChatGPT + API',
  anthropic: 'Claude + API',
  'lm-studio': 'Local models',
  ollama: 'Local models',
  'google-gemini': 'Gemini API',
  groq: 'Fast inference',
  openrouter: 'Model router',
  'github-copilot': 'Copilot account',
  xai: 'Grok API',
};

function gateProviderSubtitle(provider: AuthDisplayProvider) {
  if (provider.configured) return 'Ready to chat';
  return GATE_PROVIDER_SUBTITLES[provider.id] ?? 'Cloud API';
}

export function AuthProviderList({
  providers,
  selectedProviderId,
  configuredCount,
  onSelectProvider,
  onRefresh,
  onEnterChat,
  variant = 'settings',
}: AuthProviderListProps) {
  if (variant === 'gate') {
    return (
      <div className="flex min-h-0 w-full flex-col gap-4" style={{ WebkitAppRegion: 'no-drag' as const }}>
        {configuredCount > 0 ? (
          <div className="rounded-[20px] bg-emerald-300/[0.065] px-4 py-3 text-[12px] leading-5 text-emerald-50/90 shadow-[inset_0_0_0_1px_rgba(110,231,183,0.12)]">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="font-medium text-white">Provider saved — you can start chatting.</div>
                <div className="mt-0.5 text-[11px] text-emerald-50/75">Enter chat now, or add another source.</div>
              </div>
              {onEnterChat ? (
                <Button
                  type="button"
                  variant="secondary"
                  className="app-control-chip h-8.5 shrink-0 rounded-full border-0 px-3.5 text-[12px]"
                  onClick={() => { void onEnterChat(); }}
                  style={{ WebkitAppRegion: 'no-drag' as const, cursor: 'pointer' }}
                >
                  Enter chat
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}

        <div className="grid min-h-0 grid-cols-[repeat(2,minmax(0,1fr))] gap-3">
          {providers.map((provider) => {
            const selected = provider.id === selectedProviderId;

            return (
              <button
                key={provider.id}
                type="button"
                onClick={() => onSelectProvider(provider.id)}
                className={cn(
                  'group flex min-h-[88px] w-full cursor-pointer items-center gap-3 rounded-[22px] bg-white/[0.032] px-4 py-4 text-left transition shadow-[inset_0_0_0_1px_rgba(255,255,255,0.045)]',
                  selected
                    ? 'bg-white/[0.065] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.075),0_14px_34px_-26px_rgba(0,0,0,0.65)]'
                    : 'hover:bg-white/[0.055] hover:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.075)]',
                )}
                style={{ WebkitAppRegion: 'no-drag' as const }}
              >
                <AuthProviderGlyph providerId={provider.id} label={provider.label} size="sm" />

                <div className="min-w-0 flex-1">
                  <div className="truncate text-[14px] font-medium tracking-[-0.015em] text-white/95">{provider.label}</div>
                  <div className="mt-1 truncate text-[12px] text-slate-400">{gateProviderSubtitle(provider)}</div>
                </div>

                {provider.configured ? (
                  <div className="rounded-full bg-emerald-300/[0.09] px-2.5 py-1 text-[11px] text-emerald-50/80">Ready</div>
                ) : (
                  <ChevronRight className={cn('h-4 w-4 shrink-0 text-slate-500 transition group-hover:text-slate-300', selected && 'text-slate-300')} />
                )}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div
      className="app-surface-muted app-auth-provider-list flex h-full min-h-0 w-full min-w-0 max-w-none flex-1 flex-col self-stretch overflow-hidden rounded-[24px] border border-white/6 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
      style={{ width: '100%', maxWidth: '100%', WebkitAppRegion: 'no-drag' as const }}
    >
      <div className="mb-3 flex shrink-0 items-start justify-between gap-3 px-2 py-1">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <div className="text-[14px] font-medium tracking-[-0.015em] text-white">Choose a provider</div>
            <div className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11px] text-slate-300">
              {configuredCount} saved · {providers.length} total
            </div>
          </div>
          <div className="mt-1.5 max-w-[42ch] text-[12px] leading-5 text-slate-400">
            Pick a cloud account or a local model server. One working connection is enough.
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

      {configuredCount > 0 ? (
        <div className="mb-3 rounded-[20px] border border-emerald-300/16 bg-emerald-300/[0.06] px-3.5 py-3 text-[12px] leading-5 text-emerald-50/90">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="font-medium text-white">Provider saved — you can start chatting.</div>
              <div className="mt-0.5 text-[11px] text-emerald-50/75">Enter chat now, or configure another source from the list below.</div>
            </div>
            {onEnterChat ? (
              <Button
                type="button"
                variant="secondary"
                className="app-control-chip h-8.5 shrink-0 rounded-full border-0 px-3.5 text-[12px]"
                onClick={() => { void onEnterChat(); }}
                style={{ WebkitAppRegion: 'no-drag' as const, cursor: 'pointer' }}
              >
                enter chat
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      <ScrollArea className="min-h-0 flex-1 pr-1">
        <div className="w-full overflow-hidden rounded-[22px] border border-white/8 bg-white/[0.025] shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
          {providers.map((provider, index) => {
            const selected = provider.id === selectedProviderId;

            return (
              <button
                key={provider.id}
                type="button"
                onClick={() => onSelectProvider(provider.id)}
                className={cn(
                  'app-auth-provider-row flex w-full cursor-pointer items-center gap-3.5 px-[18px] py-3.5 text-left transition',
                  selected
                    ? 'bg-white/[0.055] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.055)]'
                    : 'hover:bg-white/[0.032]',
                  index > 0 && 'border-t border-white/8',
                )}
                style={{ WebkitAppRegion: 'no-drag' as const }}
              >
                <AuthProviderGlyph providerId={provider.id} label={provider.label} size="sm" />

                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium text-white/95">{provider.label}</div>
                  <div className="mt-0.5 truncate text-[11px] text-slate-400">{providerListSubtitle(provider)}</div>
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
