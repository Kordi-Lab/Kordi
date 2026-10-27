import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { SettingsSwitch } from '@/kordi-app/components/settingsLayout';
import { DEVICE_SOURCES, privacySettingsUrl } from './deviceAccess';
import type { CgDeviceStatuses, CgHost } from './host';
import { CgButton, CgGroup, CgIcon, CgRow, CgSection } from './parts';
import type { CgDeviceItem, CgDeviceSource } from './types';

export type CgDeviceTitles = Partial<Record<CgDeviceSource, CgDeviceItem[]>>;

/** Calendar and Reminders on this Mac: Allow, Settings, or a switch with the count; then the rows passed in. */
export function DeviceRows({ host, titles, setTitles, included, setIncluded, children }: {
  host: CgHost;
  titles: CgDeviceTitles;
  setTitles: (update: (current: CgDeviceTitles) => CgDeviceTitles) => void;
  included: CgDeviceSource[];
  setIncluded: (update: (current: CgDeviceSource[]) => CgDeviceSource[]) => void;
  children?: ReactNode;
}) {
  const device = host.device;
  const [status, setStatus] = useState<CgDeviceStatuses | null>(null);
  const [errors, setErrors] = useState<Partial<Record<CgDeviceSource, string>>>({});
  const generation = useRef<object | null>(null);
  const refresh = useCallback(async (requested?: CgDeviceSource, onGranted?: () => void) => {
    if (!device) return;
    const current = {};
    generation.current = current;
    const active = () => generation.current === current;
    // Clear evidence while rechecking access, including after returning from Settings.
    setTitles(() => ({}));
    setStatus(null);
    setErrors({});
    try {
      const next = await (requested ? device.request(requested) : device.status());
      if (!active()) return;
      setStatus(next);
      await Promise.all(DEVICE_SOURCES.map(async ({ id, name }) => {
        if (next[id] !== 'granted') return;
        try {
          const items = await device.titles(id);
          if (!active()) return;
          setTitles((previous) => active() ? { ...previous, [id]: items } : previous);
          if (id === requested) onGranted?.();
        } catch {
          if (active()) setErrors((previous) => ({ ...previous, [id]: `Could not read ${name}.` }));
        }
      }));
    } catch {
      if (active()) setErrors({ calendar: 'Could not check access.', reminders: 'Could not check access.' });
    }
  }, [device, setTitles]);
  useEffect(() => {
    const recheck = () => { void refresh(); };
    recheck();
    window.addEventListener('focus', recheck);
    return () => {
      generation.current = null;
      window.removeEventListener('focus', recheck);
    };
  }, [refresh]);
  const rows = device ? DEVICE_SOURCES.filter(({ id }) => status?.[id] !== 'unavailable') : [];
  if (!rows.length && !children) return null;
  return (
    <CgSection title="On this Mac">
      <CgGroup>
        {rows.map(({ id, name, tone, Icon }) => {
          const value = status?.[id];
          const count = titles[id]?.length;
          let sub = status ? 'Reading…' : 'Checking access…';
          let trailing = <SettingsSwitch label={name} enabled={included.includes(id)} disabled={value !== 'granted' || !count}
            onChange={(on) => setIncluded((current) => on ? [...new Set([...current, id])] : current.filter((item) => item !== id))} />;
          if (errors[id] || (value === 'granted' && count === 0)) {
            sub = errors[id] ?? (id === 'calendar' ? 'No titles in the past 180 or next 60 days.' : 'No reminder titles found.');
            trailing = <CgButton quiet label={`Retry ${name}`} onClick={() => { void refresh(); }}>Retry</CgButton>;
          } else if (value === 'granted' && count !== undefined) {
            sub = `${count} titles`;
          } else if (value === 'not_determined') {
            sub = 'Titles and dates only';
            trailing = <CgButton label={`Allow ${name}`} onClick={() => {
              void refresh(id, () => setIncluded((current) => [...new Set([...current, id])]));
            }}>Allow</CgButton>;
          } else if (value && value !== 'granted') {
            sub = 'Access is off';
            trailing = <CgButton quiet onClick={() => host.openUrl(privacySettingsUrl(id))}>Settings</CgButton>;
          }
          return <CgRow key={id} lead={<CgIcon tone={tone}><Icon className="h-4 w-4" /></CgIcon>} title={name} sub={sub} trailing={trailing} />;
        })}
        {children}
      </CgGroup>
    </CgSection>
  );
}
