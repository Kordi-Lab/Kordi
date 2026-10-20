import { useState } from 'react';
import type { ReactNode } from 'react';

import { connectorDefinition } from '@/features/connectors/connectorsModel';
import { connectorIcons } from '@/features/connectors/connectorsPanelConstants';
import { CONNECTORS_LINK_PROVIDER_IDS, type ConnectorsLinkProviderId } from '@/features/connectors/connectorsSettingsLink';
import type { CgConnectorsAccess } from './host';
import { CgButton, CgGroup, CgIcon, CgNotice, CgRow, CgSection } from './parts';
import type { useConnectorStates } from './useConnectorStates';

/** What each connector adds to a card, as in the iOS build screen. */
const READS: Record<ConnectorsLinkProviderId, string> = {
  gmail: 'Paper, review and conference threads',
  google_calendar: 'Talks and meetings',
  github: 'Repositories and bio',
  slack: 'Channels you choose',
};

const TONES: Record<ConnectorsLinkProviderId, string> = { gmail: 'pink', google_calendar: 'accent', github: 'gray', slack: 'violet' };

/** One row per connector with Set up or Remove, then the rows passed in. */
export function ConnectorsSection({ access, connectors, children }: {
  access: CgConnectorsAccess | null;
  connectors: ReturnType<typeof useConnectorStates>;
  children?: ReactNode;
}) {
  const [confirming, setConfirming] = useState<ConnectorsLinkProviderId | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { states, refresh, watch } = connectors;
  const remove = async (id: ConnectorsLinkProviderId) => {
    if (!access) return;
    setBusy(true);
    setError(null);
    try {
      await access.client.disconnect(id);
      setConfirming(null);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : `Could not remove ${connectorDefinition(id).name}.`);
    } finally {
      setBusy(false);
    }
  };
  const rows = access ? CONNECTORS_LINK_PROVIDER_IDS.map((id) => {
    const { name } = connectorDefinition(id);
    const Icon = connectorIcons[id];
    const status = states?.[id];
    let sub = status === 'needs_reauth' ? 'Sign in again' : READS[id];
    let trailing = (
      <CgButton quiet onClick={() => { setError(null); access.openSettings(id); watch(); }} label={`Set up ${name}`}>Set up</CgButton>
    );
    if (status === 'connected') {
      sub = 'Connected';
      trailing = <CgButton quiet onClick={() => setConfirming(id)} label={`Remove ${name}`}>Remove</CgButton>;
    }
    if (status === 'connected' && confirming === id) {
      sub = `Remove ${name}?`;
      trailing = (
        <span className="cg-row-actions">
          <CgButton quiet disabled={busy} onClick={() => setConfirming(null)}>Cancel</CgButton>
          <CgButton danger disabled={busy} onClick={() => void remove(id)}>Remove</CgButton>
        </span>
      );
    }
    return <CgRow key={id} lead={<CgIcon tone={TONES[id]}><Icon className="h-4 w-4" /></CgIcon>} title={name} sub={states === null ? 'Loading…' : sub} trailing={states === null ? null : trailing} />;
  }) : null;
  if (!rows && !children) return null;
  return (
    <CgSection title="Connectors">
      <CgGroup>
        {rows}
        {children}
      </CgGroup>
      <CgNotice text={error} />
    </CgSection>
  );
}
