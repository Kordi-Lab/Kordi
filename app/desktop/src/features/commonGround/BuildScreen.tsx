import { useEffect, useState } from 'react';
import { Brain, Monitor } from 'lucide-react';

import { SettingsSwitch } from '@/kordi-app/components/settingsLayout';
import { ConnectorsSection } from './BuildConnectors';
import { DeviceRows, type CgDeviceTitles } from './BuildDeviceRows';
import { DocumentsRow } from './BuildDocuments';
import { agentFilesSummary, buildFailureMessage, canBuildProfile, commonGroundBuildRequest, notesHint, type CgBuildChoices } from './buildRequest';
import { DEVICE_SOURCES } from './deviceAccess';
import type { CgHost } from './host';
import { CgAvatar, CgBack, CgGroup, CgHero, CgIcon, CgNotice, CgProgress, CgRow, CgSection } from './parts';
import { buildTitle } from './profiles';
import { currentProfile, type CgState, type CommonGroundStore } from './store';
import type { CgAgentFile } from './types';
import { includedConnectors, useConnectorStates } from './useConnectorStates';
import { useSourcePicks } from './useSourcePicks';

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

/** Build for the current card: Kordi, connected accounts, this Mac, links and notes. Keyed by profile. */
export function BuildScreen({ state, store, host }: { state: CgState; store: CommonGroundStore; host: CgHost }) {
  const connectors = useConnectorStates(host.connectors);
  const agentFiles = useAgentFiles(host.agentFiles);
  const profile = currentProfile(state);
  const sourcesOn = Boolean(host.sources);
  const top = state.stack[state.stack.length - 1];
  const { picks, change } = useSourcePicks(store, profile?.profileId ?? null, profile?.sources, top.name === 'build' && Boolean(top.memory), sourcesOn);
  const [titles, setTitles] = useState<CgDeviceTitles>({});

  const building = state.owner?.build.status === 'building' || state.busy === 'build';
  if (building) return <CgProgress line="Building your card" />;

  const set = (patch: Partial<typeof picks>) => change((current) => ({ ...current, ...patch }));
  const choices: CgBuildChoices = {
    memory: picks.memory && host.memoryAvailable,
    connectors: includedConnectors(picks.connectors, connectors.states),
    useAgents: picks.agents,
    agentFiles,
    device: DEVICE_SOURCES
      .filter(({ id }) => picks.device.includes(id) && titles[id]?.length)
      .map(({ id, label }) => ({ source: label, items: titles[id] ?? [] })),
    links: picks.links,
    notes: picks.notes,
    ...(sourcesOn ? { documents: picks.documents, picks } : {}),
  };
  const failed = state.owner?.build.status === 'failed' && !state.notice ? buildFailureMessage(state.owner.build.errorCode) : null;
  const hasAgentFiles = Boolean(agentFiles?.length);
  const agentsRow = host.agentFiles ? (
    <CgRow
      lead={<CgIcon><Monitor className="h-4 w-4" /></CgIcon>}
      title="Agents"
      sub={agentFilesSummary(agentFiles)}
      trailing={<SettingsSwitch label="Agents on this Mac" enabled={picks.agents && hasAgentFiles} disabled={!hasAgentFiles} onChange={(agents) => set({ agents })} />}
    />
  ) : null;
  const memoryRow = host.memoryAvailable ? (
    <CgRow
      lead={<CgIcon tone="violet"><Brain className="h-4 w-4" /></CgIcon>}
      title="Memory"
      trailing={<SettingsSwitch label="Memory" enabled={picks.memory} onChange={(memory) => set({ memory })} />}
    />
  ) : null;
  const documentsRow = sourcesOn ? <DocumentsRow client={store.client} chosen={picks.documents} onChange={(documents) => set({ documents })} /> : null;

  return (
    <>
      {state.stack.length > 1 ? <CgBack onBack={() => store.back()} /> : null}
      <CgHero avatar={<CgAvatar person={host.self} size={72} isSelf />} title={buildTitle(profile)} line={profile?.focus || undefined} />
      {memoryRow || documentsRow ? <CgSection title="Kordi"><CgGroup className="cg-docs-group">{memoryRow}{documentsRow}</CgGroup></CgSection> : null}
      <ConnectorsSection
        access={host.connectors}
        connectors={connectors}
        picked={picks.connectors}
        onPick={(id, on) => change((current) => ({ ...current, connectors: on ? [...new Set([...current.connectors, id])] : current.connectors.filter((item) => item !== id) }))}
      />
      <DeviceRows
        host={host}
        titles={titles}
        setTitles={setTitles}
        included={picks.device}
        setIncluded={(update) => change((current) => ({ ...current, device: update(current.device) }))}
      >
        {agentsRow}
      </DeviceRows>
      <CgSection title="Links">
        <CgGroup>
          <textarea className="cg-textarea" value={picks.links} onChange={(event) => set({ links: event.target.value })} placeholder="Homepage; ORCID; papers" aria-label="Links" />
        </CgGroup>
      </CgSection>
      <CgSection title="Notes">
        <CgGroup>
          <textarea className="cg-textarea" value={picks.notes} onChange={(event) => set({ notes: event.target.value })} placeholder={notesHint(profile?.kind)} aria-label="Notes" />
        </CgGroup>
      </CgSection>
      <div className="cg-actions-center">
        <CgNotice text={state.notice ?? failed} />
        <button type="button" className="cg-build-pill" disabled={!canBuildProfile(choices)} onClick={() => void store.build(commonGroundBuildRequest(choices))}>
          Build
        </button>
      </div>
    </>
  );
}
