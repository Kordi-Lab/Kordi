import type { CalendarEvent, DeviceCalendarEvent } from './types';

/**
 * Pure reconciliation between the device calendar store and the account's Kordi calendar.
 * The baseline records what this device last settled, keyed by the device identity, so the
 * planner can tell "changed here" from "changed there" and "deleted" from "never synced".
 */
/** `suppressed`: removed in Kordi while the device copy could not (yet) be removed. Ignored until the device copy disappears. */
export type SyncBaselineEntry = { serverId: string; fingerprint: string; revision: number; calendarId?: string; suppressed?: boolean };
export type SyncBaseline = Record<string, SyncBaselineEntry>;
/** `deviceStartAt`: where the existing device copy starts now, so one occurrence of a repeating event can be found. */
export type DeviceWrite = { event: CalendarEvent; deviceId?: string; calendarId?: string | null; deviceStartAt?: string };
export type CalendarSyncPlan = {
  upserts: CalendarEvent[];
  deletes: CalendarEvent[];
  deviceWrites: DeviceWrite[];
  deviceDeletes: { deviceId: string; externalUid: string; startAt: string }[];
  /** Kordi-created events this device should claim on the server before copying them to its calendar. */
  claims: CalendarEvent[];
  /** Which device identity each upserted server row belongs to on this device, for the baseline. */
  deviceUidByServerId: Record<string, string>;
  baseline: SyncBaseline;
};
export type CalendarSyncInput = {
  device: DeviceCalendarEvent[];
  server: CalendarEvent[];
  baseline: SyncBaseline;
  excludedCalendarIds?: Iterable<string>;
  /** Device calendars that cannot be changed (birthdays, subscribed holidays). Kordi edits and removals stay Kordi-only there. */
  readOnlyCalendarIds?: Iterable<string>;
  outbound?: { enabled: boolean; calendarId?: string | null };
  /** This installation's claim id. Without it, Kordi-created events are never copied to the device. */
  installationId?: string;
  now?: Date;
};

export const SYNC_WINDOW_PAST_DAYS = 30;
export const SYNC_WINDOW_FUTURE_DAYS = 180;
export const DEVICE_UID_PREFIX = 'device:';
/** Dispatched on `window` when a read shows the account calendar changed on the server. */
export const DIGEST_CALENDAR_SERVER_CHANGED_EVENT = 'kordi:digest-calendar-server-changed';
/** A device that is about to copy a Kordi-created event into its calendar first claims the row with `claim:<installation>`. */
export const CLAIM_UID_PREFIX = 'claim:';

/** Signals the sync scheduler. Uses the window's own event constructor and never throws into the caller. */
export function notifyCalendarSync(type: string, accountId: string) {
  if (typeof window === 'undefined') return;
  try { window.dispatchEvent(new window.CustomEvent(type, { detail: { accountId } })); } catch { /* The periodic sync still runs. */ }
}

export function syncWindow(now = new Date()) {
  const from = new Date(now); from.setDate(from.getDate() - SYNC_WINDOW_PAST_DAYS); from.setHours(0, 0, 0, 0);
  const to = new Date(now); to.setDate(to.getDate() + SYNC_WINDOW_FUTURE_DAYS); to.setHours(0, 0, 0, 0);
  return { from: from.toISOString(), to: to.toISOString() };
}

function instant(value: string | null | undefined, allDay: boolean) {
  if (!value) return '';
  if (allDay) return value.slice(0, 10);
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().replace(/\.\d{3}Z$/, 'Z') : value;
}
/** Content that both stores hold. Reminders, sources and links are Kordi-only and never conflict. */
export function contentFingerprint(event: Pick<CalendarEvent, 'title' | 'startAt' | 'endAt' | 'allDay' | 'description'>): string {
  return JSON.stringify([event.title.trim(), instant(event.startAt, event.allDay), instant(event.endAt, event.allDay), !!event.allDay, (event.description ?? '').trim()]);
}
function merged(base: CalendarEvent, content: Pick<CalendarEvent, 'title' | 'startAt' | 'endAt' | 'allDay' | 'description'>): CalendarEvent {
  const endAt = content.endAt && Date.parse(content.endAt) === Date.parse(content.startAt) ? null : content.endAt ?? null;
  return { ...base, title: content.title, startAt: content.startAt, endAt, allDay: content.allDay, description: content.description ?? '' };
}
function fromDevice(event: DeviceCalendarEvent): CalendarEvent {
  const { deviceId: _deviceId, calendarId: _calendarId, modifiedAt: _modifiedAt, ...rest } = event;
  return merged({ ...rest, sourceIds: [], reminderAt: null, revision: 0, externalUid: event.externalUid }, event);
}
function deviceIsNewer(device: DeviceCalendarEvent, server: CalendarEvent) {
  const deviceAt = Date.parse(device.modifiedAt ?? ''), serverAt = Date.parse(server.updatedAt ?? '');
  // Unknown timestamps favour the device: it is the store the user just touched.
  return !Number.isFinite(deviceAt) || !Number.isFinite(serverAt) || deviceAt >= serverAt;
}
function withinWindow(event: CalendarEvent, now: Date) {
  const { from, to } = syncWindow(now);
  const start = Date.parse(event.startAt);
  return Number.isFinite(start) && start >= Date.parse(from) && start < Date.parse(to);
}

/**
 * The device store can hand back one identity more than once: the same invitation in two
 * calendars, or a delegated copy. Keep one copy per identity, preferring a calendar that is
 * still synced and then the most recently modified copy.
 */
export function dedupeDeviceEvents(device: DeviceCalendarEvent[], excluded: Set<string>): DeviceCalendarEvent[] {
  const byUid = new Map<string, DeviceCalendarEvent>();
  for (const item of device) {
    if (!item.externalUid) continue;
    const current = byUid.get(item.externalUid);
    if (!current) { byUid.set(item.externalUid, item); continue; }
    const currentExcluded = excluded.has(current.calendarId), itemExcluded = excluded.has(item.calendarId);
    if (currentExcluded !== itemExcluded) { if (currentExcluded) byUid.set(item.externalUid, item); continue; }
    if (Date.parse(item.modifiedAt ?? '') > Date.parse(current.modifiedAt ?? '')) byUid.set(item.externalUid, item);
  }
  return [...byUid.values()];
}

export function planCalendarSync({ device: rawDevice, server, baseline, excludedCalendarIds = [], readOnlyCalendarIds = [], outbound = { enabled: true }, installationId, now = new Date() }: CalendarSyncInput): CalendarSyncPlan {
  const excluded = new Set(excludedCalendarIds);
  const readOnly = new Set(readOnlyCalendarIds);
  const device = dedupeDeviceEvents(rawDevice, excluded);
  const serverByUid = new Map<string, CalendarEvent>(), serverById = new Map<string, CalendarEvent>();
  for (const event of server) { serverById.set(event.id, event); if (event.externalUid) serverByUid.set(event.externalUid, event); }
  const plan: CalendarSyncPlan = { upserts: [], deletes: [], deviceWrites: [], deviceDeletes: [], claims: [], deviceUidByServerId: {}, baseline: {} };
  const upsertFor = (uid: string, event: CalendarEvent) => { plan.deviceUidByServerId[event.id] = uid; plan.upserts.push(event); };
  const seen = new Set<string>();
  const settle = (uid: string, current: CalendarEvent, calendarId: string) => { plan.baseline[uid] = { serverId: current.id, fingerprint: contentFingerprint(current), revision: current.revision, calendarId }; };
  for (const item of device) {
    const uid = item.externalUid, prior = baseline[uid];
    // Earlier imports keyed the identity on the start time as well; adopt those rows instead of duplicating them.
    const legacyUid = `${uid.replace(/:occurrence:-?\d+$/, '')}:${item.startAt}`;
    const current = serverByUid.get(uid) ?? (prior && serverById.get(prior.serverId)) ?? serverByUid.get(legacyUid);
    if (excluded.has(item.calendarId)) {
      if (current) { seen.add(current.id); if (prior) plan.deletes.push(current); }
      continue;
    }
    if (!current) {
      if (prior) {
        // Removed in Kordi. Try to remove the device copy, and keep ignoring this identity while any copy
        // remains (a read-only subscribed calendar, or the same invitation in a second calendar).
        if (!prior.suppressed && !readOnly.has(item.calendarId)) plan.deviceDeletes.push({ deviceId: item.deviceId, externalUid: uid, startAt: item.startAt });
        plan.baseline[uid] = { ...prior, suppressed: true };
      } else upsertFor(uid, fromDevice(item));
      continue;
    }
    seen.add(current.id);
    const deviceFingerprint = contentFingerprint(item), serverFingerprint = contentFingerprint(current);
    // A row already owned by another device's copy keeps that identity, so two devices never trade it back and forth.
    const ownedElsewhere = !!current.externalUid?.startsWith(DEVICE_UID_PREFIX) && current.externalUid !== uid && current.externalUid !== legacyUid;
    const adopt = !ownedElsewhere && current.externalUid !== uid;
    const pushDevice = () => upsertFor(uid, { ...merged(current, item), externalUid: ownedElsewhere ? current.externalUid : uid });
    const pushServer = () => { if (!readOnly.has(item.calendarId)) plan.deviceWrites.push({ event: { ...current, externalUid: uid }, deviceId: item.deviceId, calendarId: item.calendarId, deviceStartAt: item.startAt }); };
    if (deviceFingerprint === serverFingerprint) {
      if (adopt) upsertFor(uid, { ...current, externalUid: uid });
      else settle(uid, current, item.calendarId);
      continue;
    }
    if (!prior) { if (deviceIsNewer(item, current)) pushDevice(); else pushServer(); continue; }
    const deviceChanged = deviceFingerprint !== prior.fingerprint, serverChanged = serverFingerprint !== prior.fingerprint;
    if (deviceChanged && !serverChanged) pushDevice();
    else if (serverChanged && !deviceChanged) pushServer();
    else if (deviceIsNewer(item, current)) pushDevice();
    else pushServer();
  }
  const priorByServerId = new Map(Object.entries(baseline).map(([uid, entry]) => [entry.serverId, uid]));
  for (const event of server) {
    if (seen.has(event.id)) continue;
    if (event.externalUid?.startsWith(CLAIM_UID_PREFIX)) {
      // Claimed by this installation in an earlier pass that did not finish: finish the copy. Other claims belong to other devices.
      if (installationId && event.externalUid === CLAIM_UID_PREFIX + installationId && outbound.enabled && withinWindow(event, now)) plan.deviceWrites.push({ event, calendarId: outbound.calendarId ?? null });
      continue;
    }
    if (event.externalUid?.startsWith(DEVICE_UID_PREFIX)) {
      // Missing here but settled before: the user removed it from the device calendar.
      // Never settled here: another device's calendar. Leave it alone.
      if (baseline[event.externalUid]) plan.deletes.push(event);
      continue;
    }
    if (event.externalUid || event.revision === 0) continue;
    if (priorByServerId.has(event.id)) { plan.deletes.push(event); continue; }
    if (installationId && outbound.enabled && withinWindow(event, now)) plan.claims.push(event);
  }
  return plan;
}
