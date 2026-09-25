import { useMemo, useState } from 'react';
import { RefreshCw, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { SettingsRow, SettingsSection } from '@/kordi-app/components/settingsLayout';
import { AuthProviderGlyph } from './AuthProviderGlyph';
import type { AuthDisplayProvider } from './model';
import { providerListSubtitle } from './model';
import { providerListDescription, providerShortName } from './providerCopy';

type AuthProviderListProps = {
  providers: AuthDisplayProvider[];
  catalogCaption?: string;
  notice?: string | null;
  onSelectProvider: (providerId: string) => void;
  onRefresh: () => void;
  variant?: 'settings' | 'gate';
};

/** One line under the provider name: qualifier, how to connect and model count, or what is saved. */
function providerDescription(provider: AuthDisplayProvider) {
  if (provider.configured) {
    if (provider.localBaseUrl) return 'Local model ready';
    const accounts = provider.methods.reduce((count, method) => count + (method.mode === 'oauth' ? method.options.length : 0), 0);
    const keys = provider.methods.reduce((count, method) => count + (method.mode === 'api-key' ? method.options.length : 0), 0);
    const parts = [
      accounts > 0 ? `${accounts} ${accounts === 1 ? 'account' : 'accounts'}` : null,
      keys > 0 ? `${keys} API ${keys === 1 ? 'key' : 'keys'}` : null,
    ].filter(Boolean);
    return parts.length > 0 ? `${parts.join(' and ')} saved` : providerListSubtitle(provider);
  }
  if (provider.id === 'custom') return 'Base URL, model and API key';
  if (provider.localBaseUrl) return 'Local models on this Mac';
  return providerListDescription(provider) || 'Add an account or key';
}

export function AuthProviderList({
  providers,
  catalogCaption,
  notice,
  onSelectProvider,
  onRefresh,
  variant = 'settings',
}: AuthProviderListProps) {
  const [query, setQuery] = useState('');
  const { connected, groups } = useMemo(() => {
    const filtered = providers
      .filter((provider) => [provider.label, provider.id, ...provider.methods.flatMap((method) => [method.title, method.providerId])]
        .join(' ').toLowerCase().includes(query.trim().toLowerCase()))
      .sort((left, right) => left.label.localeCompare(right.label));
    const grouped = new Map<string, AuthDisplayProvider[]>();
    for (const provider of filtered.filter((item) => !item.configured)) {
      const letter = /^[A-Z]$/.test(provider.label[0]?.toUpperCase() ?? '')
        ? provider.label[0].toUpperCase() : '#';
      grouped.set(letter, [...(grouped.get(letter) ?? []), provider]);
    }
    return { connected: filtered.filter((item) => item.configured), groups: [...grouped.entries()] };
  }, [providers, query]);

  const providerRow = (provider: AuthDisplayProvider) => (
    <SettingsRow
      key={provider.id}
      className="app-auth-provider-index-row app-auth-provider-row"
      icon={<AuthProviderGlyph providerId={provider.id} label={provider.label} size="sm" />}
      title={<span className="block truncate">{providerShortName(provider.label)}</span>}
      description={<span className="block truncate">{providerDescription(provider)}</span>}
      chevron
      onClick={() => onSelectProvider(provider.id)}
    />
  );

  return (
    <div className={variant === 'gate' ? 'flex w-full flex-col gap-4' : 'flex h-full min-h-0 w-full flex-col gap-4'}>
      <div className="grid gap-1.5">
        <div className="flex items-center gap-2">
          <label className="relative min-w-0 flex-1">
            <Search aria-hidden="true" className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
            <input
              aria-label="Search providers"
              placeholder={`Search ${providers.length} providers`}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="h-10 w-full rounded-xl border-0 bg-white/[0.045] pl-10 pr-3 text-[13px] text-white outline-none placeholder:text-slate-500 focus-visible:ring-2 focus-visible:ring-white/35"
            />
          </label>
          {variant === 'settings' ? (
            <Button type="button" variant="quiet" className="h-10 rounded-xl px-3 text-[12px]" onClick={onRefresh} aria-label="Refresh providers">
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          ) : null}
        </div>
        {catalogCaption ? <p className="m-0 px-1 text-[11px] text-slate-500">{catalogCaption}</p> : null}
        {notice ? <p role="note" data-auth-page-notice="" className="m-0 px-1 text-[12px] leading-5 text-slate-400">{notice}</p> : null}
      </div>

      <div className={variant === 'gate' ? 'flex h-[min(60vh,530px)] min-h-0 gap-3' : 'flex min-h-0 flex-1 gap-3'}>
        <ScrollArea className="min-h-0 min-w-0 flex-1">
          <div className="px-2 pb-3">
            {connected.length > 0 ? (
              <SettingsSection title="Connected" ariaLabel="Connected providers" id={`provider-index-${variant}-connected`}>
                {connected.map(providerRow)}
              </SettingsSection>
            ) : null}
            {groups.map(([letter, items]) => (
              <SettingsSection key={letter} size="compact" title={letter} ariaLabel={`${letter} providers`} id={`provider-index-${variant}-${letter}`}>
                {items.map(providerRow)}
              </SettingsSection>
            ))}
            {connected.length === 0 && groups.length === 0 ? (
              <p className="px-4 py-6 text-center text-[12px] text-slate-400">
                {query.trim() ? <>No providers match “{query.trim()}”.</> : 'No providers to show yet.'}
              </p>
            ) : null}
          </div>
        </ScrollArea>

        <nav aria-label="Provider index" className="hidden w-6 shrink-0 flex-col items-center justify-center gap-0.5 sm:flex">
          {groups.map(([letter]) => (
            <button
              key={letter}
              type="button"
              className="h-5 w-5 rounded text-[10px] font-medium text-slate-500 hover:bg-white/10 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-white/40"
              onClick={() => document.getElementById(`provider-index-${variant}-${letter}`)?.scrollIntoView({ block: 'start' })}
              aria-label={`Jump to ${letter} providers`}
            >
              {letter}
            </button>
          ))}
        </nav>
      </div>
    </div>
  );
}
