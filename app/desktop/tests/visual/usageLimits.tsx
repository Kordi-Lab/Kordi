import { StrictMode, useLayoutEffect, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

import { CloudUsagePanel, type CloudUsageClient } from '../../src/features/cloud/CloudUsagePanel';
import type { CloudOrganizationRole, OrganizationUsageSummary, UsageSnapshot } from '../../src/features/cloud/usageClient';
import '../../src/index.css';

// Synthetic data only. `?theme=light` switches the theme; the default is dark.
const theme = new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark';
localStorage.setItem('kordi.themeMode.v1', theme);

const RESETS_AT = new Date(Date.UTC(2026, 10, 5)).toISOString();
const PAUSED_SINCE = new Date(Date.UTC(2026, 10, 4, 14, 20)).toISOString();
const snapshot = (
  limitId: UsageSnapshot['limitId'],
  usedPercent: number,
  amounts: [number, number] | null,
  extra: Partial<UsageSnapshot> = {},
): UsageSnapshot => ({
  limitId,
  scope: limitId.startsWith('pool') ? 'pool' : limitId.startsWith('account') ? 'account' : 'conversation',
  usedPercent, window: 'day', resetsAt: RESETS_AT, reached: 'none',
  ...(amounts ? { used: amounts[0], limit: amounts[1] } : {}),
  ...extra,
});

function organizations(role: CloudOrganizationRole): OrganizationUsageSummary[] {
  const amounts = role !== 'member';
  const team: OrganizationUsageSummary = {
    organizationId: 'org_example_team', name: 'Example team', kind: 'team', role,
    snapshots: [
      snapshot('pool.runs', 100, amounts ? [10, 10] : null, { reached: 'daily_limit', pausedSince: PAUSED_SINCE }),
      snapshot('pool.spend', 80, amounts ? [800_000, 1_000_000] : null),
      snapshot('conversation.system_agent_runs', 40, amounts ? [4, 10] : null, { conversationId: 'conv_preview' }),
    ],
  };
  if (!amounts) return [team];
  return [
    { organizationId: 'org_personal', name: 'Personal', kind: 'personal', role: 'owner', snapshots: [snapshot('account.grounding_runs', 25, [5, 20])] },
    team,
    { organizationId: 'org_studio', name: 'Studio', kind: 'team', role, snapshots: [snapshot('pool.stopped', 0, null, { reached: 'stopped' })] },
  ];
}

const client = (role: CloudOrganizationRole): CloudUsageClient => ({ accountUsage: async () => organizations(role) });
const ownerClient = client('owner');
const memberClient = client('member');
const ownerSession = () => Promise.resolve({ token: 'preview', accountId: 'acct_preview_owner' });
const memberSession = () => Promise.resolve({ token: 'preview', accountId: 'acct_preview_member' });

function SettingsFrame({ label, children }: { label: string; children: ReactNode }) {
  return (
    <figure className="m-0" aria-label={label}>
      <div className="app-transient-surface app-modal-panel app-cloud-account-settings-dialog w-[560px] overflow-hidden rounded-[12px]">
        <div className="app-main-panel app-cloud-account-settings-page"><div className="px-8 pb-8 pt-8">{children}</div></div>
      </div>
    </figure>
  );
}

function UsageLimitsPreview() {
  useLayoutEffect(() => {
    document.body.classList.toggle('theme-light', theme === 'light');
    document.body.classList.toggle('theme-dark', theme === 'dark');
    document.documentElement.style.colorScheme = theme;
  }, []);
  return (
    <div
      className={`kordi-app theme-${theme} min-h-screen p-6`}
      style={theme === 'dark' ? { background: '#101824', color: 'rgb(255 255 255)' } : { background: 'var(--app-main-bg)', color: 'rgb(15 23 42)' }}
    >
      <div className="flex flex-wrap items-start gap-6">
        <SettingsFrame label="Owner"><CloudUsagePanel accountId="acct_preview_owner" client={ownerClient} sessionLoader={ownerSession} /></SettingsFrame>
        <SettingsFrame label="Member"><CloudUsagePanel accountId="acct_preview_member" client={memberClient} sessionLoader={memberSession} /></SettingsFrame>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><UsageLimitsPreview /></StrictMode>);
