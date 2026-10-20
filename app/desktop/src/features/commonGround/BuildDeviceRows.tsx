import { useCallback, useEffect, useState } from 'react';

import { SettingsSwitch } from '@/kordi-app/components/settingsLayout';
import { DEVICE_SOURCES, privacySettingsUrl } from './deviceAccess';
import type { CgDeviceStatuses, CgHost } from './host';
import { CgButton, CgGroup, CgIcon, CgNotice, CgRow, CgSection } from './parts';
import type { CgDeviceItem, CgDeviceSource } from './types';

export type CgDeviceTitles = Partial<Record<CgDeviceSource, CgDeviceItem[]>>;

/** Calendar and Reminders on this Mac: Allow, Settings, or a switch with the count. */
export function DeviceRows({ host, titles, setTitles, included, setIncluded }: {
  host: CgHost;
  titles: CgDeviceTitles;
  setTitles: (update: (current: CgDeviceTitles) => CgDeviceTitles) => void;
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
        {rows.map(({ id, name, tone, Icon }) => {
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
          return <CgRow key={id} lead={<CgIcon tone={tone}><Icon className="h-4 w-4" /></CgIcon>} title={name} sub={sub} trailing={trailing} />;
        })}
      </CgGroup>
      <CgNotice text={error} />
    </CgSection>
  );
}
