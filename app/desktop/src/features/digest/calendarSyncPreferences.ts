import { notifyCalendarSync, type SyncBaseline } from './calendarSync';

export type CalendarSyncPreferences = {
  /** Device calendars the user opted out of. Everything else syncs. */
  excludedCalendarIds: string[];
  /** Device calendar that receives Kordi-created events. `null` means the system default. */
  targetCalendarId: string | null;
  /** Whether Kordi-created events are written to the device calendar. */
  outbound: boolean;
};
export const CALENDAR_SYNC_PREFERENCES_EVENT = 'kordi:digest-calendar-sync-preferences';
const defaults = (): CalendarSyncPreferences => ({ excludedCalendarIds: [], targetCalendarId: null, outbound: true });
const preferencesKey = (accountId: string) => `kordi.digest.calendarSync.preferences:${accountId}`;
const baselineKey = (accountId: string) => `kordi.digest.calendarSync.baseline:${accountId}`;

function storage(): Storage | null { try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; } }
function readJson<T>(key: string): T | null {
  try { const raw = storage()?.getItem(key); return raw ? JSON.parse(raw) as T : null; } catch { return null; }
}
export function readCalendarSyncPreferences(accountId: string): CalendarSyncPreferences {
  const stored = readJson<Partial<CalendarSyncPreferences>>(preferencesKey(accountId));
  const base = defaults();
  if (!stored || typeof stored !== 'object') return base;
  return {
    excludedCalendarIds: Array.isArray(stored.excludedCalendarIds) ? stored.excludedCalendarIds.filter((id): id is string => typeof id === 'string') : base.excludedCalendarIds,
    targetCalendarId: typeof stored.targetCalendarId === 'string' ? stored.targetCalendarId : null,
    outbound: typeof stored.outbound === 'boolean' ? stored.outbound : base.outbound,
  };
}
export function writeCalendarSyncPreferences(accountId: string, preferences: CalendarSyncPreferences) {
  try { storage()?.setItem(preferencesKey(accountId), JSON.stringify(preferences)); } catch { /* Preferences fall back to defaults when storage is unavailable. */ }
  notifyCalendarSync(CALENDAR_SYNC_PREFERENCES_EVENT, accountId);
}
export function readCalendarSyncBaseline(accountId: string): SyncBaseline {
  const stored = readJson<SyncBaseline>(baselineKey(accountId));
  return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
}
export function writeCalendarSyncBaseline(accountId: string, baseline: SyncBaseline) {
  try { storage()?.setItem(baselineKey(accountId), JSON.stringify(baseline)); } catch { /* A lost baseline only costs one latest-wins reconciliation. */ }
}
export function clearCalendarSyncBaseline(accountId: string) {
  try { storage()?.removeItem(baselineKey(accountId)); } catch { /* Nothing to clear. */ }
}

const installationKey = (accountId: string) => `kordi.digest.calendarSync.installation:${accountId}`;
const volatileInstallations = new Map<string, string>();
/** Stable id for this app installation, used to claim Kordi-created events before copying them to the device. */
export function readCalendarSyncInstallationId(accountId: string): string {
  const store = storage();
  try {
    const stored = store?.getItem(installationKey(accountId));
    if (stored) return stored;
  } catch { /* Fall back to an in-memory id below. */ }
  const id = volatileInstallations.get(accountId) ?? (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
  volatileInstallations.set(accountId, id);
  try { store?.setItem(installationKey(accountId), id); } catch { /* Kept in memory for this session. */ }
  return id;
}
