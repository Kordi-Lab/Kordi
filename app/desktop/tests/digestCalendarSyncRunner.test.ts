import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { contentFingerprint, type SyncBaseline } from '../src/features/digest/calendarSync';
import { CALENDAR_SYNC_DEBOUNCE_MS, CalendarPermissionError, calendarSyncStoreFor, scheduleCalendarSync, syncDeviceCalendarOnce, type CalendarSyncDeps } from '../src/features/digest/calendarSyncRunner';
import { CALENDAR_SYNC_PREFERENCES_EVENT, readCalendarSyncBaseline, readCalendarSyncPreferences, writeCalendarSyncBaseline, writeCalendarSyncPreferences } from '../src/features/digest/calendarSyncPreferences';
import type { CalendarEvent, CalendarSyncResult, DeviceCalendarAccess, DeviceCalendarEvent } from '../src/features/digest/types';

function environment() {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true, url: 'https://kordi.test/' });
  const previous = { window: globalThis.window, document: globalThis.document, CustomEvent: globalThis.CustomEvent, localStorage: (globalThis as { localStorage?: Storage }).localStorage };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, CustomEvent: dom.window.CustomEvent, localStorage: dom.window.localStorage });
  return { dom, cleanup: () => { Object.assign(globalThis, previous); dom.window.close(); } };
}
const deviceEvent = (overrides: Partial<DeviceCalendarEvent> = {}): DeviceCalendarEvent => ({ id: 'calendar-a', title: 'Standup', startAt: '2026-09-17T09:00:00Z', endAt: '2026-09-17T09:30:00Z', allDay: false, sourceIds: [], description: '', reminderAt: null, revision: 0, externalUid: 'device:a', deviceId: 'ek-a', calendarId: 'work', modifiedAt: '2026-09-16T11:00:00Z', ...overrides });
const kordiEvent: CalendarEvent = { id: 'digest-1', title: 'Design review', startAt: '2026-09-18T15:00:00+00:00', endAt: '2026-09-18T16:00:00+00:00', allDay: false, sourceIds: ['m1'], description: '', reminderAt: null, revision: 2, externalUid: null, updatedAt: '2026-09-15T10:00:00Z' };

type Recorded = { access: boolean[]; reads: string[][]; writes: { id: string; deviceId?: string | null; calendarId?: string | null }[]; deletes: string[]; syncs: { upserts: CalendarEvent[]; deletes: { id: string; revision: number }[] }[]; refreshed: number; baselines: SyncBaseline[] };
function fakeDeps(options: { permission?: DeviceCalendarAccess[]; device?: DeviceCalendarEvent[]; server?: CalendarEvent[]; baseline?: SyncBaseline; watch?: (onChange: () => void) => void } = {}) {
  const recorded: Recorded = { access: [], reads: [], writes: [], deletes: [], syncs: [], refreshed: 0, baselines: [] };
  const permissions = options.permission ?? ['granted'];
  let baseline = options.baseline ?? {};
  const deps: CalendarSyncDeps = {
    isNative: () => true,
    access: async request => { recorded.access.push(request); return permissions.length > 1 ? permissions.shift()! : permissions[0]; },
    calendars: async () => [{ id: 'work', title: 'Work', allowsModifications: true }, { id: 'holidays', title: 'Holidays', allowsModifications: false }],
    readEvents: async ids => { recorded.reads.push(ids); return options.device ?? []; },
    writeEvent: async (event, target) => { recorded.writes.push({ id: event.id, deviceId: target.deviceId, calendarId: target.calendarId }); return { deviceId: target.deviceId ?? `ek-${event.id}`, externalUid: event.externalUid?.startsWith('device:') ? event.externalUid : `device:new-${event.id}` }; },
    deleteEvent: async target => { recorded.deletes.push(target.deviceId); },
    watch: async onChange => { options.watch?.(onChange); return () => {}; },
    serverEvents: async () => options.server ?? [],
    serverSync: async (_account, changes) => {
      recorded.syncs.push(changes);
      const saved = changes.upserts.map(event => ({ ...event, revision: event.revision + 1, updatedAt: '2026-09-16T12:00:00Z' }));
      const result: CalendarSyncResult = { saved, conflicts: [], skipped: [], deleted: changes.deletes.map(item => item.id), deleteConflicts: [], capacity: 900 };
      return result;
    },
    preferences: () => ({ excludedCalendarIds: [], targetCalendarId: 'work', outbound: true }),
    installationId: () => 'mac-1',
    readBaseline: () => baseline,
    writeBaseline: (_account, next) => { baseline = next; recorded.baselines.push(next); },
    afterServerChange: async () => { recorded.refreshed++; },
    now: () => Date.parse('2026-09-16T12:00:00Z'),
  };
  return { deps, recorded, baseline: () => baseline };
}

test('one pass writes device changes first, records identities server-side, and settles the baseline', async () => {
  const { deps, recorded, baseline } = fakeDeps({ permission: ['notDetermined', 'granted'], device: [deviceEvent()], server: [kordiEvent] });
  const result = await syncDeviceCalendarOnce('viewer', deps);
  assert.deepEqual(recorded.access, [false, true], 'permission is requested only while undetermined');
  assert.deepEqual(recorded.reads, [['work', 'holidays']]);
  assert.deepEqual(recorded.writes, [{ id: 'digest-1', deviceId: undefined, calendarId: 'work' }]);
  assert.equal(recorded.syncs.length, 2, 'a claim round, then the reconciliation batch');
  assert.deepEqual(recorded.syncs[0].upserts.map(event => [event.id, event.externalUid, event.revision]), [['digest-1', 'claim:mac-1', 2]]);
  const ids = recorded.syncs[1].upserts.map(event => [event.id, event.externalUid, event.revision]);
  assert.deepEqual(ids, [['calendar-a', 'device:a', 0], ['digest-1', 'device:new-digest-1', 3]]);
  assert.equal(recorded.refreshed, 1);
  assert.equal(result.permission, 'granted');
  assert.equal(result.calendars.length, 2);
  assert.equal(result.syncedCount, 2);
  assert.deepEqual(Object.keys(baseline()).sort(), ['device:a', 'device:new-digest-1']);
  assert.equal(baseline()['device:a'].revision, 1);
  assert.equal(baseline()['device:a'].calendarId, 'work');
  assert.equal(baseline()['device:new-digest-1'].serverId, 'digest-1');
  assert.equal(baseline()['device:new-digest-1'].revision, 4);
});

test('a second pass with nothing changed makes no writes, a device deletion clears the baseline entry, and a Kordi-side removal keeps a suppressed baseline entry', async () => {
  const synced: CalendarEvent = { ...deviceEvent(), revision: 1, updatedAt: '2026-09-16T12:00:00Z' };
  delete (synced as Partial<DeviceCalendarEvent>).deviceId; delete (synced as Partial<DeviceCalendarEvent>).calendarId; delete (synced as Partial<DeviceCalendarEvent>).modifiedAt;
  const baseline: SyncBaseline = { 'device:a': { serverId: 'calendar-a', fingerprint: contentFingerprint(synced), revision: 1, calendarId: 'work' } };
  const quiet = fakeDeps({ device: [deviceEvent()], server: [synced], baseline });
  const result = await syncDeviceCalendarOnce('viewer', quiet.deps);
  assert.deepEqual([quiet.recorded.writes, quiet.recorded.deletes, quiet.recorded.syncs], [[], [], []]);
  assert.equal(quiet.recorded.refreshed, 0);
  assert.equal(result.changed, false);
  const removed = fakeDeps({ device: [], server: [synced], baseline });
  await syncDeviceCalendarOnce('viewer', removed.deps);
  assert.deepEqual(removed.recorded.syncs[0].deletes, [{ id: 'calendar-a', revision: 1 }]);
  assert.deepEqual(removed.baseline(), {});
  const removedInKordi = fakeDeps({ device: [deviceEvent()], server: [], baseline });
  await syncDeviceCalendarOnce('viewer', removedInKordi.deps);
  assert.deepEqual(removedInKordi.recorded.deletes, ['ek-a']);
  assert.deepEqual(removedInKordi.recorded.syncs, []);
  const remainingBaseline = removedInKordi.baseline();
  assert.equal(remainingBaseline['device:a']?.serverId, 'calendar-a');
  assert.equal(remainingBaseline['device:a']?.suppressed, true);
});

test('denied permission stops the pass before any read', async () => {
  const { deps, recorded } = fakeDeps({ permission: ['denied'] });
  await assert.rejects(() => syncDeviceCalendarOnce('viewer', deps), (error: unknown) => error instanceof CalendarPermissionError && error.permission === 'denied');
  assert.deepEqual(recorded.reads, []);
});

test('preferences and baselines are stored per account and survive malformed storage', () => {
  const { cleanup } = environment();
  try {
    assert.deepEqual(readCalendarSyncPreferences('viewer'), { excludedCalendarIds: [], targetCalendarId: null, outbound: true });
    let notified = 0;
    window.addEventListener(CALENDAR_SYNC_PREFERENCES_EVENT, () => notified++);
    writeCalendarSyncPreferences('viewer', { excludedCalendarIds: ['holidays'], targetCalendarId: 'work', outbound: false });
    assert.equal(notified, 1);
    assert.deepEqual(readCalendarSyncPreferences('viewer'), { excludedCalendarIds: ['holidays'], targetCalendarId: 'work', outbound: false });
    assert.deepEqual(readCalendarSyncPreferences('other'), { excludedCalendarIds: [], targetCalendarId: null, outbound: true });
    window.localStorage.setItem('kordi.digest.calendarSync.preferences:broken', '{not json');
    assert.deepEqual(readCalendarSyncPreferences('broken'), { excludedCalendarIds: [], targetCalendarId: null, outbound: true });
    writeCalendarSyncBaseline('viewer', { 'device:a': { serverId: 'calendar-a', fingerprint: 'fp', revision: 1 } });
    assert.deepEqual(readCalendarSyncBaseline('viewer'), { 'device:a': { serverId: 'calendar-a', fingerprint: 'fp', revision: 1 } });
    window.localStorage.setItem('kordi.digest.calendarSync.baseline:list', '[1,2]');
    assert.deepEqual(readCalendarSyncBaseline('list'), {});
  } finally { cleanup(); }
});

test('the scheduler syncs on start, on device changes and on preference changes without overlapping runs', async t => {
  const { dom, cleanup } = environment();
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let onChange: (() => void) | null = null;
  const { deps, recorded } = fakeDeps({ device: [deviceEvent()], watch: callback => { onChange = callback; } });
  let release: (() => void) | null = null;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const original = deps.serverEvents;
  let reads = 0;
  deps.serverEvents = async account => { reads++; if (reads === 1) await gate; return original(account); };
  const store = calendarSyncStoreFor('viewer');
  const stop = scheduleCalendarSync('viewer', deps);
  try {
    assert.equal(store.getSnapshot().phase, 'idle');
    t.mock.timers.tick(CALENDAR_SYNC_DEBOUNCE_MS);
    await Promise.resolve(); await Promise.resolve();
    assert.equal(store.getSnapshot().phase, 'syncing');
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(onChange, 'the native observer was attached');
    onChange!(); onChange!();
    t.mock.timers.tick(CALENDAR_SYNC_DEBOUNCE_MS);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(reads, 1, 'changes during a run queue one follow-up instead of overlapping');
    release!();
    for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(reads, 2, 'the queued follow-up ran once the first pass finished');
    assert.equal(store.getSnapshot().phase, 'synced');
    assert.equal(store.getSnapshot().calendars.length, 2);
    assert.equal(recorded.syncs.length, 1, 'the second pass found nothing new to push');
    window.dispatchEvent(new dom.window.CustomEvent(CALENDAR_SYNC_PREFERENCES_EVENT, { detail: { accountId: 'someone-else' } }));
    t.mock.timers.tick(CALENDAR_SYNC_DEBOUNCE_MS);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(reads, 2, 'other accounts do not trigger this scheduler');
    window.dispatchEvent(new dom.window.CustomEvent(CALENDAR_SYNC_PREFERENCES_EVENT, { detail: { accountId: 'viewer' } }));
    t.mock.timers.tick(CALENDAR_SYNC_DEBOUNCE_MS);
    for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(reads, 3);
  } finally {
    stop();
    assert.equal(store.getSnapshot().phase, 'idle');
    cleanup();
  }
});

test('the scheduler reports a permission state instead of an error and web builds report unavailable', async t => {
  const { cleanup } = environment();
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const denied = fakeDeps({ permission: ['denied'] });
  const store = calendarSyncStoreFor('denied-account');
  const stop = scheduleCalendarSync('denied-account', denied.deps);
  try {
    t.mock.timers.tick(CALENDAR_SYNC_DEBOUNCE_MS);
    for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(store.getSnapshot().phase, 'permission');
    assert.equal(store.getSnapshot().permission, 'denied');
    const web = fakeDeps();
    web.deps.isNative = () => false;
    const stopWeb = scheduleCalendarSync('web-account', web.deps);
    assert.equal(calendarSyncStoreFor('web-account').getSnapshot().phase, 'unavailable');
    stopWeb();
  } finally { stop(); cleanup(); }
});

test('a lost claim never writes to the device, and a failed server call cannot duplicate a new device copy', async () => {
  const lost = fakeDeps({ server: [kordiEvent] });
  lost.deps.serverSync = async (_account, changes) => { lost.recorded.syncs.push(changes); return { saved: [], conflicts: changes.upserts.map(event => event.id), skipped: [], deleted: [], deleteConflicts: [], capacity: 900 }; };
  await syncDeviceCalendarOnce('viewer', lost.deps);
  assert.deepEqual(lost.recorded.writes, [], 'another device claimed it first');

  const failing = fakeDeps({ server: [kordiEvent] });
  const original = failing.deps.serverSync;
  let calls = 0;
  failing.deps.serverSync = async (account, changes) => { calls++; if (calls === 2) throw new Error('Network unavailable'); return original(account, changes); };
  await assert.rejects(() => syncDeviceCalendarOnce('viewer', failing.deps), /Network unavailable/);
  assert.equal(failing.recorded.writes.length, 1);
  const kept = failing.baseline()['device:new-digest-1'];
  assert.equal(kept?.serverId, 'digest-1', 'the new device copy is recorded before the server call');
  // Next pass: the device now holds the copy and the server row still carries this installation's claim.
  const claimedRow: CalendarEvent = { ...kordiEvent, externalUid: 'claim:mac-1', revision: 3 };
  const copy = deviceEvent({ id: 'calendar-copy', externalUid: 'device:new-digest-1', deviceId: 'ek-digest-1', title: kordiEvent.title, startAt: kordiEvent.startAt, endAt: kordiEvent.endAt });
  const retry = fakeDeps({ device: [copy], server: [claimedRow], baseline: failing.baseline() });
  await syncDeviceCalendarOnce('viewer', retry.deps);
  assert.deepEqual(retry.recorded.writes, [], 'no second device copy');
  assert.deepEqual(retry.recorded.syncs.map(batch => batch.upserts.map(event => [event.id, event.externalUid])), [[['digest-1', 'device:new-digest-1']]]);
});
