import { useEffect, useState } from 'react';
import { Plug, RadioTower } from 'lucide-react';
import { DEFAULT_LOCAL_AGENT_AVATAR_SEED } from '@/features/canonical/localAgentAvatar';
import { cloudDefaultAgentPresentation } from '@/features/cloud/cloudAgentIdentity';
import type { CloudAccount } from '@/features/cloud/cloudIdentityTypes';
import { ConnectorLogo } from '@/features/connectors/ConnectorLogo';
import { connectorCatalog, type ConnectorProviderId } from '@/features/connectors/connectorsModel';
import { IdentityAvatar } from '@/kordi-app/components/IdentityAvatar';
import { SettingsRow, SettingsSection, SettingsSwitch } from '@/kordi-app/components';
import { formatDesktopLastActiveLabel } from '@/lib/time';
import { openPersonalAgentSession } from './personalAgentPageState';
import { defaultPersonalAgentId } from './personalAgentEntries';
import { usePersonalAgentEntries } from './personalAgentStore';
import { openConnectorsSettings, personalAgentPageStatus, refreshPersonalAgentStatus, setDefaultPersonalAgentProactive, useDefaultPersonalAgentStatus } from './personalAgentStatus';

const REFRESH_MS = 60_000;

function providerName(provider: string) {
  return connectorCatalog.find((definition) => definition.providerId === provider)?.name ?? provider;
}

function knownProvider(provider: string): provider is ConnectorProviderId {
  return connectorCatalog.some((definition) => definition.providerId === provider);
}

function timeLabel(at: string) {
  const ms = Date.parse(at);
  return Number.isFinite(ms) ? formatDesktopLastActiveLabel(ms) : '';
}

/**
 * The owner's Personal agent: its default agent watching the connectors
 * granted to it. Not set up without a connector; otherwise an On/Off switch,
 * what it watches, and what it shared, each opening the agent's chat.
 */
export function PersonalAgentPage({ account }: { account?: CloudAccount | null }) {
  const status = useDefaultPersonalAgentStatus();
  const entries = usePersonalAgentEntries();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const timer = window.setInterval(() => { void refreshPersonalAgentStatus(); }, REFRESH_MS);
    const onFocus = () => { void refreshPersonalAgentStatus(); };
    window.addEventListener('focus', onFocus);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', onFocus); };
  }, []);
  const agent = account ? cloudDefaultAgentPresentation(account) : null;
  const defaultEntry = account ? entries.find((entry) => entry.agentId === defaultPersonalAgentId(account.accountId)) : undefined;
  const toggle = (next: boolean) => {
    setSaving(true);
    setError(null);
    setDefaultPersonalAgentProactive(next)
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Could not update Personal agent.'))
      .finally(() => setSaving(false));
  };
  const connected = status?.connected === true;
  return (
    <section className="app-personal-agent-page" aria-label="Personal agent" data-testid="personal-agent-page">
      <header className="app-personal-agent-page-header">
        <IdentityAvatar kind="agent" seed={DEFAULT_LOCAL_AGENT_AVATAR_SEED} name={agent?.name ?? 'Kordi'} imageUrl={agent?.avatarUrl}
          className="h-[30px] w-[30px]" presenceStatus={status?.proactive ? 'online' : undefined} />
        <div className="app-personal-agent-page-title">
          <h2>Personal agent</h2>
          {agent ? <span>{agent.name}</span> : null}
        </div>
        {status ? (
          <SettingsSwitch enabled={status.proactive} label="Personal agent" disabled={!connected || saving} onChange={toggle} />
        ) : null}
      </header>
      {!status ? <div className="app-personal-agent-page-body" aria-busy="true" /> : !connected ? (
        <div className="app-personal-agent-page-empty">
          <span className="app-personal-agent-page-empty-icon"><RadioTower className="h-6 w-6" aria-hidden="true" /></span>
          <p>Add a connector to turn it on.</p>
          <button type="button" className="app-personal-agent-page-connect" onClick={openConnectorsSettings}>
            <Plug className="h-4 w-4" aria-hidden="true" />Connect
          </button>
        </div>
      ) : (
        <div className="app-personal-agent-page-body">
          <p className="app-personal-agent-page-status" data-on={status.proactive ? '' : undefined}>
            <span aria-hidden="true" />{personalAgentPageStatus(status)}
          </p>
          {error ? <p role="alert" className="app-personal-agent-page-error">{error}</p> : null}
          <SettingsSection title="Watching" size="compact" className={status.proactive ? undefined : 'is-off'}>
            {status.sources.map((source) => (
              <SettingsRow key={source.connectorId} title={providerName(source.provider)}
                icon={knownProvider(source.provider) ? <ConnectorLogo providerId={source.provider} /> : <Plug className="h-4 w-4" aria-hidden="true" />} />
            ))}
            <SettingsRow title="Manage connectors" onClick={openConnectorsSettings} chevron />
          </SettingsSection>
          {status.recent.length > 0 ? (
            <SettingsSection title="Recent" size="compact">
              {status.recent.map((entry) => (
                <SettingsRow key={`${entry.at}:${entry.text}`} title={entry.text}
                  icon={<time className="app-personal-agent-page-time" dateTime={entry.at}>{timeLabel(entry.at)}</time>}
                  onClick={defaultEntry ? () => openPersonalAgentSession(defaultEntry.sessionId) : undefined}
                  chevron={Boolean(defaultEntry)} />
              ))}
            </SettingsSection>
          ) : null}
        </div>
      )}
    </section>
  );
}
