import { useEffect, useState } from 'react';
import { Brain, Monitor } from 'lucide-react';

import { SettingsSwitch } from '@/kordi-app/components/settingsLayout';
import { ConnectorsSection } from './BuildConnectors';
import { DeviceRows, type CgDeviceTitles } from './BuildDeviceRows';
import { agentFilesSummary, canBuildProfile, commonGroundBuildRequest, type CgBuildChoices } from './buildRequest';
import { DEVICE_SOURCES } from './deviceAccess';
import type { CgHost } from './host';
import { CgAvatar, CgBack, CgGroup, CgHero, CgIcon, CgNotice, CgProgress, CgRow, CgSection } from './parts';
import { buildTitle } from './profiles';
import { currentProfile, hasAnyCard, type CgState, type CommonGroundStore } from './store';
import type { CgAgentFile, CgDeviceSource } from './types';
import { useConnectorStates } from './useConnectorStates';

function useAgentFiles(read: CgHost['agentFiles']) {
  const [files, setFiles] = useState<CgAgentFile[] | null>(read ? null : []);
  useEffect(() => {
    if (!read) return;
    let cancelled = false;
    void read().then((found) => { if (!cancelled) setFiles(found); }, () => { if (!cancelled) setFiles([]); });
    return () => { cancelled = true; };
  }, [read]);
  return files;
}

export function BuildScreen({ state, store, host }: { state: CgState; store: CommonGroundStore; host: CgHost }) {
  const connectors = useConnectorStates(host.connectors);
  const agentFiles = useAgentFiles(host.agentFiles);
  const [useAgents, setUseAgents] = useState(false);
  const [useMemory, setUseMemory] = useState(false);
  const [links, setLinks] = useState('');
  const [notes, setNotes] = useState('');
  const [titles, setTitles] = useState<CgDeviceTitles>({});
  const [included, setIncluded] = useState<CgDeviceSource[]>([]);

  const profile = currentProfile(state);
  const building = state.owner?.build.status === 'building' || state.busy === 'build';
  if (building) return <CgProgress line="Your agent is writing your card" />;

  const choices: CgBuildChoices = {
    memory: useMemory && host.memoryAvailable,
    connectedCount: connectors.connectedCount,
    useAgents,
    agentFiles,
    device: DEVICE_SOURCES
      .filter(({ id }) => included.includes(id) && titles[id]?.length)
      .map(({ id, label }) => ({ source: label, items: titles[id] ?? [] })),
    links,
    notes,
  };
  const failed = state.owner?.build.status === 'failed' && !state.notice ? 'Could not build your card. Try again.' : null;
  const hasAgentFiles = Boolean(agentFiles?.length);
  const agentsRow = host.agentFiles ? (
    <CgRow
      lead={<CgIcon><Monitor className="h-4 w-4" /></CgIcon>}
      title="Agents on this Mac"
      sub={agentFilesSummary(agentFiles)}
      trailing={<SettingsSwitch label="Agents on this Mac" enabled={useAgents && hasAgentFiles} disabled={!hasAgentFiles} onChange={setUseAgents} />}
    />
  ) : null;
  const memoryRow = host.memoryAvailable ? (
    <CgRow
      lead={<CgIcon tone="violet"><Brain className="h-4 w-4" /></CgIcon>}
      title="Memory"
      sub="Your saved memories"
      trailing={<SettingsSwitch label="Memory" enabled={useMemory} onChange={setUseMemory} />}
    />
  ) : null;

  return (
    <>
      {hasAnyCard(state) && state.stack.length > 1 ? <CgBack onBack={() => store.back()} /> : null}
      <CgHero avatar={<CgAvatar person={host.self} size={72} isSelf />} title={buildTitle(profile)} line={profile?.focus || 'Your agent writes it'} />
      {host.connectors || agentsRow || memoryRow ? (
        <ConnectorsSection access={host.connectors} connectors={connectors}>
          {agentsRow || memoryRow ? <>{agentsRow}{memoryRow}</> : undefined}
        </ConnectorsSection>
      ) : null}
      <DeviceRows host={host} titles={titles} setTitles={setTitles} included={included} setIncluded={setIncluded} />
      <CgSection title="Links">
        <CgGroup>
          <textarea className="cg-textarea" value={links} onChange={(event) => setLinks(event.target.value)} placeholder="Homepage; ORCID; papers" aria-label="Links" />
        </CgGroup>
      </CgSection>
      <CgSection title="Notes">
        <CgGroup>
          <textarea className="cg-textarea" value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="What are you working on?" aria-label="Notes" />
        </CgGroup>
      </CgSection>
      <div className="cg-actions-end">
        <CgNotice text={state.notice ?? failed} />
        <button type="button" className="cg-primary" disabled={!canBuildProfile(choices)} onClick={() => void store.build(commonGroundBuildRequest(choices))}>
          Build profile
        </button>
      </div>
    </>
  );
}
