import { useEffect, useSyncExternalStore } from 'react';
import { CLAIM_UID_PREFIX, contentFingerprint, DIGEST_CALENDAR_SERVER_CHANGED_EVENT, notifyCalendarSync, planCalendarSync, syncWindow, type DeviceWrite, type SyncBaseline } from './calendarSync';
import { CALENDAR_SYNC_PREFERENCES_EVENT, readCalendarSyncBaseline, readCalendarSyncInstallationId, readCalendarSyncPreferences, writeCalendarSyncBaseline, type CalendarSyncPreferences } from './calendarSyncPreferences';
import { connectedCalendars, deleteDeviceEvent, deviceCalendarAccess, readDeviceEvents, watchDeviceCalendar, writeDeviceEvent, type DeviceEventTarget } from './calendar';
import { calendarErrorMessage } from './calendarImport';
import { digestClient } from './client';
import { isNativeDesktopShell } from '@/lib/desktop';
import type { CalendarConnection, CalendarEvent, CalendarSyncResult, DeviceCalendarAccess, DeviceCalendarEvent } from './types';

export type CalendarSyncStatus = {
  phase: 'idle' | 'syncing' | 'synced' | 'error' | 'permission' | 'unavailable';
  permission: DeviceCalendarAccess;
  calendars: CalendarConnection[];
  lastSyncedAt: string | null;
  error: string | null;
  /** Events this device currently keeps in sync. */
  syncedCount: number;
};
export type CalendarSyncDeps = {
  isNative: () => boolean;
  access: (request: boolean) => Promise<DeviceCalendarAccess>;
  calendars: () => Promise<CalendarConnection[]>;
  readEvents: (calendarIds: string[], from: string, to: string) => Promise<DeviceCalendarEvent[]>;
  writeEvent: (event: CalendarEvent, options: { deviceId?: string | null; calendarId?: string | null; deviceStartAt?: string | null }) => Promise<{ deviceId: string; externalUid: string }>;
  deleteEvent: (target: DeviceEventTarget) => Promise<void>;
  watch: (onChange: () => void) => Promise<() => void>;
  serverEvents: (accountId: string) => Promise<CalendarEvent[]>;
  serverSync: (accountId: string, changes: { upserts: CalendarEvent[]; deletes: { id: string; revision: number }[] }) => Promise<CalendarSyncResult>;
  preferences: (accountId: string) => CalendarSyncPreferences;
  installationId: (accountId: string) => string;
  readBaseline: (accountId: string) => SyncBaseline;
  writeBaseline: (accountId: string, baseline: SyncBaseline) => void;
  afterServerChange: (accountId: string) => Promise<unknown>;
  now: () => number;
};
export const CALENDAR_SYNC_INTERVAL_MS = 15 * 60_000;
export const CALENDAR_SYNC_DEBOUNCE_MS = 1_500;
export const CALENDAR_SYNC_FOREGROUND_MIN_MS = 30_000;
const MAX_CALENDARS = 50;

export const defaultCalendarSyncDeps: CalendarSyncDeps = {
  isNative: isNativeDesktopShell,
  access: deviceCalendarAccess,
  calendars: connectedCalendars,
  readEvents: readDeviceEvents,
  writeEvent: writeDeviceEvent,
  deleteEvent: deleteDeviceEvent,
  watch: watchDeviceCalendar,
  serverEvents: async accountId => (await digestClient.calendar(accountId)).events,
  serverSync: (accountId, changes) => digestClient.sync(accountId, changes),
  preferences: readCalendarSyncPreferences,
  installationId: readCalendarSyncInstallationId,
  readBaseline: readCalendarSyncBaseline,
  writeBaseline: writeCalendarSyncBaseline,
  afterServerChange: async accountId => (await import('./store')).digestStoreFor(accountId).refresh(true),
  now: Date.now,
};

export class CalendarPermissionError extends Error {
  constructor(readonly permission: DeviceCalendarAccess) { super('Calendar access is off.'); }
}

const initialStatus = (): CalendarSyncStatus => ({ phase: 'idle', permission: 'notDetermined', calendars: [], lastSyncedAt: null, error: null, syncedCount: 0 });
class CalendarSyncStore {
  private state = initialStatus();
  private listeners = new Set<() => void>();
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  publish(patch: Partial<CalendarSyncStatus>) { this.state = { ...this.state, ...patch }; this.listeners.forEach(listener => listener()); }
  reset() { this.publish(initialStatus()); }
}
const stores = new Map<string, CalendarSyncStore>();
export function calendarSyncStoreFor(accountId: string) {
  let store = stores.get(accountId);
  if (!store) { store = new CalendarSyncStore(); stores.set(accountId, store); }
  return store;
}

/** One full reconciliation. Device writes happen first so their identities can be recorded server-side in the same batch. */
export async function syncDeviceCalendarOnce(accountId: string, deps: CalendarSyncDeps): Promise<{ calendars: CalendarConnection[]; permission: DeviceCalendarAccess; syncedCount: number; changed: boolean }> {
  let permission = await deps.access(false);
  if (permission === 'notDetermined') permission = await deps.access(true);
  if (permission !== 'granted') throw new CalendarPermissionError(permission);
  const calendars = (await deps.calendars()).slice(0, MAX_CALENDARS);
  const preferences = deps.preferences(accountId);
  const now = new Date(deps.now());
  const { from, to } = syncWindow(now);
  const device = calendars.length ? await deps.readEvents(calendars.map(calendar => calendar.id), from, to) : [];
  const server = await deps.serverEvents(accountId);
  const baseline = deps.readBaseline(accountId);
  const installationId = deps.installationId(accountId);
  const plan = planCalendarSync({ device, server, baseline, installationId, excludedCalendarIds: preferences.excludedCalendarIds, readOnlyCalendarIds: calendars.filter(calendar => calendar.allowsModifications === false).map(calendar => calendar.id), outbound: { enabled: preferences.outbound, calendarId: preferences.targetCalendarId }, now });
  const deviceByUid = new Map(device.map(item => [item.externalUid, item]));
  const next: SyncBaseline = { ...plan.baseline };
  const settle = (event: CalendarEvent, calendarId?: string, uid = plan.deviceUidByServerId[event.id] ?? event.externalUid) => {
    if (!uid?.startsWith('device:')) return;
    next[uid] = { serverId: event.id, fingerprint: contentFingerprint(event), revision: event.revision, calendarId: calendarId ?? deviceByUid.get(uid)?.calendarId ?? next[uid]?.calendarId };
  };
  const problems: string[] = [];
  for (const removal of plan.deviceDeletes) {
    try { await deps.deleteEvent(removal); } catch (error) { problems.push(calendarErrorMessage(error, 'Could not remove an event from the device calendar.')); }
  }
  let changed = false;
  const writes: DeviceWrite[] = [...plan.deviceWrites];
  if (plan.claims.length) {
    // Only the device whose claim lands (the revision check) copies the event, so two devices never both write it.
    const claimed = await deps.serverSync(accountId, { upserts: plan.claims.map(event => ({ ...event, externalUid: CLAIM_UID_PREFIX + installationId })), deletes: [] });
    for (const won of claimed.saved) writes.push({ event: won, calendarId: preferences.targetCalendarId ?? null });
    changed = claimed.saved.length > 0;
  }
  const upserts = [...plan.upserts];
  for (const write of writes) {
    try {
      const written = await deps.writeEvent(write.event, { deviceId: write.deviceId, calendarId: write.calendarId, deviceStartAt: write.deviceStartAt });
      if (write.event.externalUid === written.externalUid) settle(write.event, write.calendarId ?? undefined);
      else {
        // Record the device identity before anything else can create a second copy.
        next[written.externalUid] = { serverId: write.event.id, fingerprint: contentFingerprint(write.event), revision: write.event.revision, calendarId: write.calendarId ?? undefined };
        plan.deviceUidByServerId[write.event.id] = written.externalUid;
        upserts.push({ ...write.event, externalUid: written.externalUid });
      }
    } catch (error) { problems.push(calendarErrorMessage(error, 'Could not write an event to the device calendar.')); }
  }
  // Persist device-side effects before the server call, so a failed request never turns a new device copy into a duplicate.
  deps.writeBaseline(accountId, next);
  // One row per id per batch: a later upsert for the same id wins, and an id that is being written is never also deleted.
  const uniqueUpserts = [...new Map(upserts.map(event => [event.id, event])).values()];
  const upsertIds = new Set(uniqueUpserts.map(event => event.id));
  const deletes = plan.deletes.filter((event, index, all) => !upsertIds.has(event.id) && all.findIndex(other => other.id === event.id) === index);
  if (uniqueUpserts.length || deletes.length) {
    const result = await deps.serverSync(accountId, { upserts: uniqueUpserts, deletes: deletes.map(event => ({ id: event.id, revision: event.revision })) });
    for (const saved of result.saved) settle(saved);
    for (const event of deletes) if (result.deleted.includes(event.id) && event.externalUid) delete next[plan.deviceUidByServerId[event.id] ?? event.externalUid];
    for (const event of deletes) if (!event.externalUid) for (const [uid, entry] of Object.entries(next)) if (entry.serverId === event.id) delete next[uid];
    changed = changed || result.saved.length > 0 || result.deleted.length > 0;
    if (result.skipped.length) problems.push('Your Kordi calendar is full. Older events were not synced.');
  }
  deps.writeBaseline(accountId, next);
  if (changed) { try { await deps.afterServerChange(accountId); } catch { /* The digest route re-reads on its own poll. */ } }
  if (problems.length) throw new Error(problems[0]);
  return { calendars, permission, syncedCount: Object.keys(next).length, changed };
}

/** Keeps the device calendar and the Kordi calendar converged for as long as the shell is open. */
export function scheduleCalendarSync(accountId: string, deps: CalendarSyncDeps = defaultCalendarSyncDeps): () => void {
  const store = calendarSyncStoreFor(accountId);
  if (!deps.isNative()) { store.publish({ phase: 'unavailable', permission: 'unavailable' }); return () => {}; }
  let stopped = false, running = false, queued = false, lastForeground = 0;
  let debounce: ReturnType<typeof setTimeout> | undefined, unwatch: (() => void) | null = null;
  const run = async () => {
    if (stopped || running) { queued = running; return; }
    running = true;
    store.publish({ phase: 'syncing', error: null });
    try {
      const result = await syncDeviceCalendarOnce(accountId, deps);
      if (!stopped) store.publish({ phase: 'synced', permission: result.permission, calendars: result.calendars, lastSyncedAt: new Date(deps.now()).toISOString(), syncedCount: result.syncedCount, error: null });
    } catch (error) {
      if (stopped) return;
      if (error instanceof CalendarPermissionError) store.publish({ phase: 'permission', permission: error.permission, error: null });
      else store.publish({ phase: 'error', error: calendarErrorMessage(error, 'Calendar sync failed.') });
    } finally {
      running = false;
      if (queued && !stopped) { queued = false; void run(); }
    }
  };
  const trigger = () => { if (stopped) return; clearTimeout(debounce); debounce = setTimeout(() => void run(), CALENDAR_SYNC_DEBOUNCE_MS); };
  const foreground = () => {
    if (document.hidden || deps.now() - lastForeground < CALENDAR_SYNC_FOREGROUND_MIN_MS) return;
    lastForeground = deps.now();
    trigger();
  };
  const onPreferences = (event: Event) => { if ((event as CustomEvent<{ accountId?: string }>).detail?.accountId === accountId) trigger(); };
  trigger();
  void deps.watch(trigger).then(stop => { if (stopped) stop(); else unwatch = stop; }).catch(() => { /* Polling and foreground syncs still run without the observer. */ });
  // The tick runs even while the window is hidden: a background Kordi must still carry Kordi-created events to the device calendar.
  const interval = setInterval(trigger, CALENDAR_SYNC_INTERVAL_MS);
  window.addEventListener('focus', foreground);
  document.addEventListener('visibilitychange', foreground);
  window.addEventListener(CALENDAR_SYNC_PREFERENCES_EVENT, onPreferences);
  window.addEventListener(DIGEST_CALENDAR_SERVER_CHANGED_EVENT, onPreferences);
  return () => {
    stopped = true;
    clearTimeout(debounce);
    clearInterval(interval);
    unwatch?.();
    window.removeEventListener('focus', foreground);
    document.removeEventListener('visibilitychange', foreground);
    window.removeEventListener(CALENDAR_SYNC_PREFERENCES_EVENT, onPreferences);
    window.removeEventListener(DIGEST_CALENDAR_SERVER_CHANGED_EVENT, onPreferences);
    store.reset();
  };
}

export function useCalendarSync(accountId?: string | null) {
  useEffect(() => accountId ? scheduleCalendarSync(accountId) : undefined, [accountId]);
}
const emptyStore = new CalendarSyncStore();
export function useCalendarSyncStatus(accountId?: string | null): CalendarSyncStatus {
  const store = accountId ? calendarSyncStoreFor(accountId) : emptyStore;
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
/** Lets the Digest page ask for an immediate reconciliation after an in-app edit. */
export function requestCalendarSync(accountId: string) {
  notifyCalendarSync(CALENDAR_SYNC_PREFERENCES_EVENT, accountId);
}
