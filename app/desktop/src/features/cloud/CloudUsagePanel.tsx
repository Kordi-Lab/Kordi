import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { settingsType } from '@/kordi-app/components/settingsType';
import { cn } from '@/lib/utils';

import { loadSession } from './session';
import {
  createUsageClient,
  formatUtcClock,
  primeOrganizations,
  type CloudOrganization,
  type OrganizationUsage,
  type UsageClient,
  type UsageLimitId,
  type UsageSnapshot,
} from './usageClient';

type UsageEntry = { organization: CloudOrganization; usage: OrganizationUsage };
const cachedUsageByAccount = new Map<string, UsageEntry[]>();

export type CloudUsageClient = Pick<UsageClient, 'listOrganizations' | 'organizationUsage'>;
export type CloudUsageSessionLoader = () => Promise<{ token: string; accountId: string } | null>;

const LABELS: Record<UsageLimitId, string> = {
  'pool.runs': 'Runs',
  'pool.spend': 'Spend',
  'account.grounding_runs': 'Grounding',
  'conversation.system_agent_runs': 'System agent',
  'pool.stopped': 'System agent',
};

function usageValueLabel(snapshot: UsageSnapshot): string {
  if (typeof snapshot.used === 'number' && typeof snapshot.limit === 'number') {
    if (snapshot.limitId === 'pool.spend') {
      return `${(snapshot.used / 1_000_000).toFixed(2)} of ${(snapshot.limit / 1_000_000).toFixed(2)}`;
    }
    return `${snapshot.used} of ${snapshot.limit}`;
  }
  return `${snapshot.usedPercent}%`;
}

function usageStatusLine(snapshot: UsageSnapshot): string {
  if (snapshot.reached === 'stopped') return 'Paused by an owner.';
  const resets = formatUtcClock(snapshot.resetsAt);
  return snapshot.reached === 'none' ? `Resets at ${resets} UTC` : `Daily limit reached. Resets at ${resets} UTC.`;
}

function UsageRow({ snapshot }: { snapshot: UsageSnapshot }) {
  const percent = Math.max(0, Math.min(100, snapshot.usedPercent));
  const tone = snapshot.reached === 'stopped' ? 'bg-rose-500' : snapshot.reached === 'none' ? null : 'bg-amber-500';
  return (
    <li className="border-t border-white/10 py-3 first:border-t-0">
      <div className="flex items-center gap-4">
        <span className={cn('w-28 shrink-0', settingsType.rowTitle)}>{LABELS[snapshot.limitId] ?? snapshot.limitId}</span>
        <div
          className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-white/10"
          role="progressbar"
          aria-label={LABELS[snapshot.limitId] ?? snapshot.limitId}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <div
            className={cn('h-full rounded-full', tone)}
            style={{ width: `${percent}%`, ...(tone ? {} : { background: 'var(--app-accent)' }) }}
          />
        </div>
        <span className={cn('w-24 shrink-0 text-right tabular-nums', settingsType.value)}>{usageValueLabel(snapshot)}</span>
      </div>
      <p className={cn('m-0 mt-0.5', settingsType.description)}>{usageStatusLine(snapshot)}</p>
    </li>
  );
}

function OrganizationUsageSection({ entry }: { entry: UsageEntry }) {
  const headingId = `usage-${entry.organization.organizationId}`;
  const notice = entry.usage.notices[0];
  return (
    <section className="mt-6 first:mt-0" aria-labelledby={headingId}>
      <h3 id={headingId} className={cn('m-0', settingsType.label)}>{entry.organization.name}</h3>
      {notice ? <p className={cn('m-0', settingsType.description)}>{`${notice.threshold}% of today's limit used.`}</p> : null}
      {entry.usage.snapshots.length === 0 ? (
        <p className={cn('m-0 mt-2', settingsType.description)}>No limits.</p>
      ) : (
        <ul className="m-0 mt-1 list-none border-b border-white/10 p-0">
          {entry.usage.snapshots.map((snapshot) => <UsageRow key={snapshot.limitId} snapshot={snapshot} />)}
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
  const [entries, setEntries] = useState<UsageEntry[]>(cached ?? []);
  const [isLoading, setIsLoading] = useState(!cached);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    try {
      const session = await sessionLoader();
      if (!session?.token || session.accountId !== accountId) {
        throw new Error('The active account session is unavailable. Sign in again.');
      }
      const organizations = await usageClient.listOrganizations(session.token);
      primeOrganizations(accountId, organizations);
      const usages = await Promise.all(organizations.map((organization) => (
        usageClient.organizationUsage(session.token, organization.organizationId)
      )));
      const next = organizations.map((organization, index) => ({ organization, usage: usages[index] }));
      cachedUsageByAccount.set(accountId, next);
      setEntries(next);
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

      {isLoading && entries.length === 0 ? (
        <div className="grid min-h-32 place-items-center text-[12px] text-slate-400" role="status">
          Loading…
        </div>
      ) : entries.length === 0 ? (
        error ? null : <p className={cn('m-0 mt-5', settingsType.description)}>No limits.</p>
      ) : (
        <div className="mt-5">
          {entries.map((entry) => <OrganizationUsageSection key={entry.organization.organizationId} entry={entry} />)}
        </div>
      )}
    </div>
  );
}
