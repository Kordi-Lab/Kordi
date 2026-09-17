import { useEffect, useState } from 'react';
import { syncedAgoLabel } from './calendar';
import type { CalendarSyncStatus } from './calendarSyncRunner';

export function CalendarSyncLine({ sync, onOpenPrivacy, onRetry }: { sync: CalendarSyncStatus; onOpenPrivacy: () => void; onRetry: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(timer); }, []);
  const included = sync.calendars.length;
  switch (sync.phase) {
    case 'unavailable': return <p className="digest-sync-status">Device calendars sync automatically in the Kordi desktop app.</p>;
    case 'permission': return <p className="digest-sync-status digest-warning" role="status">Calendar access is off. <button type="button" onClick={onOpenPrivacy}>Allow Kordi in System Settings</button></p>;
    case 'error': return <p className="digest-sync-status digest-warning" role="status">Calendar sync paused: {sync.error} <button type="button" onClick={onRetry}>Retry</button></p>;
    case 'syncing': return <p className="digest-sync-status" role="status"><i aria-hidden="true"/> Syncing{included ? ` ${included} ${included === 1 ? 'calendar' : 'calendars'}` : ' calendars'}…</p>;
    case 'synced': return <p className="digest-sync-status" role="status"><i aria-hidden="true"/> Synced{included ? ` · ${included} ${included === 1 ? 'calendar' : 'calendars'}` : ''} · {syncedAgoLabel(sync.lastSyncedAt, now)}</p>;
    default: return <p className="digest-sync-status" role="status">Preparing calendar sync…</p>;
  }
}
