import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { settingsType } from '@/kordi-app/components/settingsType';
import { cn } from '@/lib/utils';

import { loadSession } from './session';
import { createUsageClient, type OrganizationUsageSummary, type UsageClient, type UsageSnapshot } from './usageClient';
import { usageBarTone, usageLabel, usageStatusLine, usageValueLabel } from './usagePresentation';

const cachedUsageByAccount = new Map<string, OrganizationUsageSummary[]>();

export type CloudUsageClient = Pick<UsageClient, 'accountUsage'>;
export type CloudUsageSessionLoader = () => Promise<{ token: string; accountId: string } | null>;

const BAR_FILL = { accent: undefined, amber: 'bg-amber-500', red: 'bg-rose-500' } as const;

function UsageRow({ snapshot, role }: { snapshot: UsageSnapshot; role: OrganizationUsageSummary['role'] }) {
  const percent = Math.max(0, Math.min(100, snapshot.usedPercent));
  const tone = usageBarTone(snapshot);
  const label = usageLabel(snapshot);
  return (
    <li className="border-t border-white/10 py-3 first:border-t-0" data-usage-tone={tone}>
      <div className="flex items-center gap-4">
        <span className={cn('w-40 shrink-0', settingsType.rowTitle)}>{label}</span>
        <div
          className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-white/10"
          role="progressbar"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <div
            className={cn('h-full rounded-full', BAR_FILL[tone])}
            style={{ width: `${percent}%`, ...(tone === 'accent' ? { background: 'var(--app-accent)' } : {}) }}
          />
        </div>
        <span className={cn('w-24 shrink-0 text-right tabular-nums', settingsType.value)}>{usageValueLabel(snapshot)}</span>
      </div>
      <p className={cn('m-0 mt-0.5', settingsType.description)}>{usageStatusLine(snapshot, role)}</p>
    </li>
  );
}

function OrganizationUsageSection({ organization }: { organization: OrganizationUsageSummary }) {
  const headingId = `usage-${organization.organizationId}`;
  return (
    <section className="mt-6 first:mt-0" aria-labelledby={headingId}>
      <h3 id={headingId} className={cn('m-0', settingsType.label)}>{organization.name}</h3>
      {organization.snapshots.length === 0 ? (
        <p className={cn('m-0 mt-2', settingsType.description)}>No limits.</p>
      ) : (
        <ul className="m-0 mt-1 list-none border-b border-white/10 p-0">
          {organization.snapshots.map((snapshot) => (
            <UsageRow key={`${snapshot.limitId}:${snapshot.conversationId ?? ''}`} snapshot={snapshot} role={organization.role} />
          ))}
        </ul>
      )}
    </section>
  );
}

export function CloudUsagePanel({
  accountId,
  client,
  sessionLoader = loadSession,
}: {
  accountId: string;
  client?: CloudUsageClient;
  /** Resolves the signed-in session. Previews inject a synthetic session. */
  sessionLoader?: CloudUsageSessionLoader;
}) {
  const usageClient = useMemo<CloudUsageClient>(() => client ?? createUsageClient(), [client]);
  const cached = cachedUsageByAccount.get(accountId);
  const [organizations, setOrganizations] = useState<OrganizationUsageSummary[]>(cached ?? []);
  const [isLoading, setIsLoading] = useState(!cached);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    try {
      const session = await sessionLoader();
      if (!session?.token || session.accountId !== accountId) {
        throw new Error('The active account session is unavailable. Sign in again.');
      }
      const next = await usageClient.accountUsage(session.token);
      cachedUsageByAccount.set(accountId, next);
      setOrganizations(next);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load usage.');
    } finally {
      setIsLoading(false);
    }
  }, [accountId, sessionLoader, usageClient]);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (active) void refresh();
    });
    return () => { active = false; };
  }, [refresh]);

  return (
    <div className="app-cloud-account-settings-section max-w-[680px] py-1">
      <div className="flex items-center justify-between gap-3">
        <h2 className={cn('m-0', settingsType.heading)}>Usage</h2>
        <Button
          variant="quiet"
          size="icon"
          className="h-8 w-8 shrink-0 rounded-full"
          onClick={() => { void refresh(); }}
          disabled={isLoading}
          aria-label="Refresh usage"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', isLoading && 'animate-spin')} />
        </Button>
      </div>

      {error ? (
        <div className="app-error-text mt-4 rounded-[12px] bg-rose-500/10 px-3 py-2 text-[12px] leading-5 text-rose-100" role="alert">
          {error}
        </div>
      ) : null}

      {isLoading && organizations.length === 0 ? (
        <div className="grid min-h-32 place-items-center text-[12px] text-slate-400" role="status">
          Loading…
        </div>
      ) : organizations.length === 0 ? (
        error ? null : <p className={cn('m-0 mt-5', settingsType.description)}>No limits.</p>
      ) : (
        <div className="mt-5">
          {organizations.map((organization) => <OrganizationUsageSection key={organization.organizationId} organization={organization} />)}
        </div>
      )}
    </div>
  );
}
