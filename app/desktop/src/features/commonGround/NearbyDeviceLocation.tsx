import { useEffect, useRef, useState } from 'react';

import { isNativeDesktopShell, openDesktopExternalUrl } from '@/lib/desktop';
import { commonGroundErrorMessage } from './client';
import { requestNearbyDeviceLocation } from './nearbyLocationFix';
import type { CgNearbyStore } from './storeNearby';

/** Any signed-in device can provide a fresh fix; no automatic or background desktop tracking. */
export function NearbyDeviceLocation({ nearby }: { nearby: CgNearbyStore }) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const active = useRef(false);
  const requesting = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);
  const locate = async () => {
    if (requesting.current) return;
    requesting.current = true;
    setBusy(true);
    setNotice(null);
    try {
      const fix = await requestNearbyDeviceLocation();
      // Navigation, sign-out, pausing, or turning Nearby off cancels publication of a late fix.
      if (!active.current || !['on', 'no-phone'].includes(nearby.phase())) return;
      await nearby.host.client.postNearbyLocation(fix);
      if (active.current) await nearby.refresh();
    } catch (error) {
      if (active.current) setNotice(commonGroundErrorMessage(error));
    } finally {
      requesting.current = false;
      if (active.current) setBusy(false);
    }
  };
  return (
    <div className="cg-nb-status cg-nb-location">
      <button type="button" className="cg-link" disabled={busy} onClick={() => void locate()}>
        {busy ? 'Finding your location…' : 'Use this device’s location'}
      </button>
      <p>Nearby uses the most recent location from any of your signed-in devices.</p>
      {notice ? <p role="status">{notice}</p> : null}
      {isNativeDesktopShell() && /Mac/.test(navigator.platform) ? <button type="button" className="cg-link" onClick={() => void openDesktopExternalUrl('x-apple.systempreferences:com.apple.preference.security?Privacy_LocationServices').catch((error) => setNotice(commonGroundErrorMessage(error)))}>Location settings</button> : null}
    </div>
  );
}
