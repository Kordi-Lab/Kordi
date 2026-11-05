import { StrictMode, useLayoutEffect, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

import { mapCanonicalMessage } from '../../src/features/canonical/readModel/messageMapping';
import { CloudUsagePanel, type CloudUsageClient } from '../../src/features/cloud/CloudUsagePanel';
import { primeOrganizations, type CloudOrganization, type OrganizationUsage, type UsageSnapshot } from '../../src/features/cloud/usageClient';
import { KORDI_SYSTEM_AVATAR_URL } from '../../src/features/systemAgent/systemAgentIdentity';
import { MessageBubble } from '../../src/kordi-app/components/transcript';
import type { CanonicalIdentity, CanonicalSessionMessage, Message } from '../../src/kordi-app/types';
import '../../src/index.css';

// Synthetic data only. `?theme=light` switches the theme; the default is dark.
const theme = new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark';
localStorage.setItem('kordi.themeMode.v1', theme);

const RESETS_AT = new Date(Date.UTC(2026, 10, 5)).toISOString();
const team = (role: CloudOrganization['role']): CloudOrganization => ({
  organizationId: 'org_example_team', name: 'Example team', kind: 'team', role, memberCount: 4, createdAt: RESETS_AT,
});
const personal: CloudOrganization = {
  organizationId: 'org_personal', name: 'Personal', kind: 'personal', role: 'owner', memberCount: 1, createdAt: RESETS_AT,
};
const snapshot = (limitId: UsageSnapshot['limitId'], usedPercent: number, reached: UsageSnapshot['reached'], amounts?: [number, number]): UsageSnapshot => ({
  limitId, scope: limitId.startsWith('pool') ? 'pool' : limitId.startsWith('account') ? 'account' : 'conversation',
  usedPercent, window: 'day', resetsAt: RESETS_AT, reached, ...(amounts ? { used: amounts[0], limit: amounts[1] } : {}),
});

function previewClient(role: CloudOrganization['role']): CloudUsageClient {
  const amounts = role !== 'member';
  return {
    listOrganizations: async () => (amounts ? [personal, team(role)] : [team(role)]),
    async organizationUsage(_token, organizationId): Promise<OrganizationUsage> {
      if (organizationId === personal.organizationId) {
        return { organizationId, role: 'owner', notices: [], snapshots: [snapshot('account.grounding_runs', 25, 'none', [5, 20])] };
      }
      return {
        organizationId,
        role,
        notices: amounts ? [{ threshold: 90, at: RESETS_AT }] : [],
        snapshots: [
          snapshot('pool.runs', 100, 'daily_limit', amounts ? [10, 10] : undefined),
          snapshot('pool.spend', 40, 'none', amounts ? [400_000, 1_000_000] : undefined),
          snapshot('conversation.system_agent_runs', 70, 'none', amounts ? [7, 10] : undefined),
        ],
      };
    },
  };
}

// The viewer owns Example team and is a member of Design guild.
primeOrganizations('acct_preview_viewer', [
  personal,
  team('owner'),
  { organizationId: 'org_design_guild', name: 'Design guild', kind: 'team', role: 'member', memberCount: 9, createdAt: RESETS_AT },
]);
const systemAgent = { id: 'human:acct_kordi_pip', kind: 'human', displayName: 'System', source: 'bridge', sourceHostId: 'cloud', sourceIdentityId: 'acct_kordi_pip',
  humanId: 'acct_kordi_pip', profileImageUrl: KORDI_SYSTEM_AVATAR_URL, createdAtMs: 1, updatedAtMs: 1 } as CanonicalIdentity;
const jordan = { id: 'human:acct_preview_jordan', kind: 'human', displayName: 'Jordan Lee', source: 'bridge', sourceHostId: 'cloud', sourceIdentityId: 'acct_preview_jordan',
  humanId: 'acct_preview_jordan', avatarKey: 'jordan-preview', createdAtMs: 1, updatedAtMs: 1 } as CanonicalIdentity;
const identities = new Map([[systemAgent.id, systemAgent], [jordan.id, jordan]]);
const row = (id: string, sender: CanonicalIdentity, messageKind: string, text: string, minute: number, usageLimit?: unknown): CanonicalSessionMessage => ({
  id, sessionId: 'session:group:preview', senderIdentityId: sender.id, senderRole: 'person', messageKind, contentText: text,
  content: { schema: 1, blocks: [{ type: 'text', text }], legacy_attachments: [], ...(usageLimit ? { usageLimit } : {}) },
  status: 'received', sequenceNum: minute, createdAtMs: Date.UTC(2026, 10, 4, 21, minute), updatedAtMs: 1, sourceTransport: 'cloud-group',
});
const limitText = 'Daily limit reached. Resets at 00:00 UTC.';
const messages = [
  row('ask', jordan, 'text', 'Can the System agent pick a time for Friday?', 1),
  row('owner', systemAgent, 'system-notice', limitText, 2, { reached: 'daily_limit', resetsAt: RESETS_AT, organizationId: 'org_example_team' }),
  row('member', systemAgent, 'system-notice', limitText, 3, { reached: 'spend_limit', resetsAt: RESETS_AT, organizationId: 'org_design_guild' }),
  row('stopped', systemAgent, 'system-notice', 'Paused by an owner.', 4, { reached: 'stopped', resetsAt: RESETS_AT, organizationId: 'org_example_team' }),
].map((message) => mapCanonicalMessage(message, identities, 'human:me')).filter((message): message is Message => Boolean(message));

const session = (accountId: string) => () => Promise.resolve({ token: 'preview', accountId });
const ownerClient = previewClient('owner');
const memberClient = previewClient('member');
const ownerSession = session('acct_preview_owner');
const memberSession = session('acct_preview_member');

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
      <div className="flex flex-wrap items-start gap-6" data-preview="usage-panels">
        <SettingsFrame label="Owner"><CloudUsagePanel accountId="acct_preview_owner" client={ownerClient} sessionLoader={ownerSession} /></SettingsFrame>
        <SettingsFrame label="Member"><CloudUsagePanel accountId="acct_preview_member" client={memberClient} sessionLoader={memberSession} /></SettingsFrame>
      </div>
      <main className="mt-6 max-w-[720px] rounded-[12px] p-6" data-preview="transcript" style={{ background: 'var(--app-chat-background, var(--background))' }}>
        {messages.map((message) => <MessageBubble key={message.id} msg={message} onOpenSenderProfile={() => {}} />)}
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><UsageLimitsPreview /></StrictMode>);
