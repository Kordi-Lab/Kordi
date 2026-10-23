import { connectorDefinition } from '@/features/connectors/connectorsModel';
import { connectorIcons } from '@/features/connectors/connectorsPanelConstants';
import { CONNECTORS_LINK_PROVIDER_IDS, type ConnectorsLinkProviderId } from '@/features/connectors/connectorsSettingsLink';
import { SettingsSwitch } from '@/kordi-app/components/settingsLayout';
import type { CgConnectorsAccess } from './host';
import { CgButton, CgGroup, CgIcon, CgRow, CgSection } from './parts';
import type { useConnectorStates } from './useConnectorStates';

/** What each connector adds to a card, as in the iOS build screen. */
const READS: Record<ConnectorsLinkProviderId, string> = {
  gmail: 'Paper, review and conference threads',
  google_calendar: 'Talks and meetings',
  github: 'Repositories and bio',
  slack: 'Channels you choose',
};

const TONES: Record<ConnectorsLinkProviderId, string> = { gmail: 'pink', google_calendar: 'accent', github: 'gray', slack: 'violet' };

/** One row per connector: a switch to include a connected one, Set up for the rest. */
export function ConnectorsSection({ access, connectors, picked, onPick }: {
  access: CgConnectorsAccess | null;
  connectors: ReturnType<typeof useConnectorStates>;
  picked: string[];
  onPick: (id: ConnectorsLinkProviderId, on: boolean) => void;
}) {
  if (!access) return null;
  const { states, watch } = connectors;
  return (
    <CgSection title="Connected accounts">
      <CgGroup>
        {CONNECTORS_LINK_PROVIDER_IDS.map((id) => {
          const { name } = connectorDefinition(id);
          const Icon = connectorIcons[id];
          const status = states?.[id];
          const trailing = status === 'connected'
            ? <SettingsSwitch label={name} enabled={picked.includes(id)} onChange={(on) => onPick(id, on)} />
            : <CgButton quiet onClick={() => { access.openSettings(id); watch(); }} label={`Set up ${name}`}>Set up</CgButton>;
          const sub = status === 'needs_reauth' ? 'Sign in again' : status === 'connected' ? 'Connected' : READS[id];
          return <CgRow key={id} lead={<CgIcon tone={TONES[id]}><Icon className="h-4 w-4" /></CgIcon>} title={name} sub={states === null ? 'Loading…' : sub} trailing={states === null ? null : trailing} />;
        })}
      </CgGroup>
    </CgSection>
  );
}
