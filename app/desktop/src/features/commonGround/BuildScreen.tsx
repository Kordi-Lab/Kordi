import { useCallback, useEffect, useState } from 'react';
import { Bell, Brain, CalendarDays, Plug } from 'lucide-react';

import { SettingsSwitch } from '@/kordi-app/components/settingsLayout';
import { privacySettingsUrl } from './deviceAccess';
import type { CgConnector, CgDeviceStatuses, CgHost } from './host';
import { CgAvatar, CgBack, CgButton, CgGroup, CgHero, CgNotice, CgProgress, CgRow, CgSection } from './parts';
import type { CgState, CommonGroundStore } from './store';
import type { CgDeviceItem, CgDeviceSource } from './types';

const DEVICE_SOURCES: Array<{ id: CgDeviceSource; name: string; label: string; Icon: typeof Bell }> = [
  { id: 'calendar', name: 'Calendar', label: 'Mac Calendar', Icon: CalendarDays },
  { id: 'reminders', name: 'Reminders', label: 'Mac Reminders', Icon: Bell },
];

function DeviceRows({ host, titles, setTitles, included, setIncluded }: {
  host: CgHost;
  titles: Partial<Record<CgDeviceSource, CgDeviceItem[]>>;
  setTitles: (update: (current: Partial<Record<CgDeviceSource, CgDeviceItem[]>>) => Partial<Record<CgDeviceSource, CgDeviceItem[]>>) => void;
  included: CgDeviceSource[];
  setIncluded: (update: (current: CgDeviceSource[]) => CgDeviceSource[]) => void;
}) {
  const device = host.device;
  const [status, setStatus] = useState<CgDeviceStatuses | null>(null);
  const [error, setError] = useState<string | null>(null);
  const read = useCallback(async (source: CgDeviceSource) => {
    if (!device) return;
    const items = await device.titles(source).catch(() => []);
    setTitles((current) => ({ ...current, [source]: items }));
  }, [device, setTitles]);
  useEffect(() => {
    if (!device) return;
    let cancelled = false;
    void device.status().then((next) => {
      if (cancelled) return;
      setStatus(next);
      DEVICE_SOURCES.forEach(({ id }) => { if (next[id] === 'granted') void read(id); });
    }, () => undefined);
    return () => { cancelled = true; };
  }, [device, read]);
  if (!device || !status) return null;
  const rows = DEVICE_SOURCES.filter(({ id }) => status[id] !== 'unavailable');
  if (!rows.length) return null;
  return (
    <CgSection title="On this Mac">
      <CgGroup>
        {rows.map(({ id, name, Icon }) => {
          const value = status[id];
          const count = titles[id]?.length;
          let sub = 'Titles and dates only';
          let trailing = (
            <CgButton onClick={() => {
              setError(null);
              void device.request(id).then(async (next) => {
                setStatus(next);
                if (next[id] === 'granted') {
                  await read(id);
                  setIncluded((current) => [...new Set([...current, id])]);
                }
              }, (caught: unknown) => setError(caught instanceof Error ? caught.message : 'Could not ask for access.'));
            }}
            >
              Allow
            </CgButton>
          );
          if (value === 'granted') {
            sub = count === undefined ? 'Reading…' : count === 0 ? 'Nothing found' : `${count} titles`;
            trailing = (
              <SettingsSwitch
                label={name}
                enabled={included.includes(id) && Boolean(count)}
                disabled={!count}
                onChange={(on) => setIncluded((current) => (on ? [...current, id] : current.filter((item) => item !== id)))}
              />
            );
          } else if (value !== 'not_determined') {
            sub = 'Access is off';
            trailing = <CgButton quiet onClick={() => host.openUrl(privacySettingsUrl(id))}>Settings</CgButton>;
          }
          return <CgRow key={id} lead={<span className="cg-icon" aria-hidden="true"><Icon className="h-4 w-4" /></span>} title={name} sub={sub} trailing={trailing} />;
        })}
      </CgGroup>
      <CgNotice text={error} />
    </CgSection>
  );
}

export function BuildScreen({ state, store, host }: { state: CgState; store: CommonGroundStore; host: CgHost }) {
  const [connectors, setConnectors] = useState<CgConnector[] | null>(null);
  const [useConnectors, setUseConnectors] = useState(false);
  const [useMemory, setUseMemory] = useState(false);
  const [links, setLinks] = useState('');
  const [notes, setNotes] = useState('');
  const [titles, setTitles] = useState<Partial<Record<CgDeviceSource, CgDeviceItem[]>>>({});
  const [included, setIncluded] = useState<CgDeviceSource[]>([]);
  useEffect(() => {
    let cancelled = false;
    void host.listConnectors().then((list) => { if (!cancelled) setConnectors(list); }, () => { if (!cancelled) setConnectors([]); });
    return () => { cancelled = true; };
  }, [host]);

  const building = state.owner?.build.status === 'building' || state.busy === 'build';
  if (building) return <CgProgress line="Your agent is writing your card" />;

  const device = DEVICE_SOURCES
    .filter(({ id }) => included.includes(id) && titles[id]?.length)
    .map(({ id, label }) => ({ source: label, items: titles[id] ?? [] }));
  const hasConnectors = Boolean(connectors?.length);
  const ready = (useConnectors && hasConnectors) || (useMemory && host.memoryAvailable) || device.length > 0
    || links.trim().length > 0 || notes.trim().length > 0;
  const failed = state.owner?.build.status === 'failed' && !state.notice ? 'Could not build your card. Try again.' : null;

  return (
    <>
      {state.owner?.card ? <CgBack onBack={() => store.back()} /> : null}
      <CgHero avatar={<CgAvatar person={host.self} size={72} isSelf />} title="Build your profile" line="Your agent writes it" />
      <CgSection title="Kordi">
        <CgGroup>
          <CgRow
            lead={<span className="cg-icon" aria-hidden="true"><Plug className="h-4 w-4" /></span>}
            title="Connectors"
            sub={connectors === null ? 'Loading…' : hasConnectors ? connectors.map((item) => item.name).join(', ') : 'None connected'}
            trailing={<SettingsSwitch label="Connectors" enabled={useConnectors && hasConnectors} disabled={!hasConnectors} onChange={setUseConnectors} />}
          />
          {host.memoryAvailable ? (
            <CgRow
              lead={<span className="cg-icon" aria-hidden="true"><Brain className="h-4 w-4" /></span>}
              title="Memory"
              sub="Your saved memories"
              trailing={<SettingsSwitch label="Memory" enabled={useMemory} onChange={setUseMemory} />}
            />
          ) : null}
        </CgGroup>
      </CgSection>
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
        <button
          type="button"
          className="cg-primary"
          disabled={!ready}
          onClick={() => void store.build({
            memory: useMemory && host.memoryAvailable,
            connectors: useConnectors && hasConnectors,
            device,
            links,
            notes,
          })}
        >
          Build profile
        </button>
      </div>
    </>
  );
}
