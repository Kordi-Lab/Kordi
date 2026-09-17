import assert from 'node:assert/strict';
import test from 'node:test';
import { contentFingerprint, planCalendarSync, syncWindow, type SyncBaseline } from '../src/features/digest/calendarSync';
import type { CalendarEvent, DeviceCalendarEvent } from '../src/features/digest/types';

const now = new Date('2026-09-16T12:00:00Z');
function device(overrides: Partial<DeviceCalendarEvent> = {}): DeviceCalendarEvent {
  return { id: 'calendar-a', title: 'Standup', startAt: '2026-09-17T09:00:00Z', endAt: '2026-09-17T09:30:00Z', allDay: false, sourceIds: [], description: '', reminderAt: null, revision: 0, externalUid: 'device:a', deviceId: 'ek-a', calendarId: 'work', modifiedAt: '2026-09-16T11:00:00Z', ...overrides };
}
function server(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return { id: 'calendar-a', title: 'Standup', startAt: '2026-09-17T09:00:00+00:00', endAt: '2026-09-17T09:30:00+00:00', allDay: false, sourceIds: [], description: '', reminderAt: '2026-09-17T08:50:00+00:00', revision: 3, externalUid: 'device:a', updatedAt: '2026-09-15T10:00:00Z', ...overrides };
}
const settled = (event: CalendarEvent, calendarId = 'work'): SyncBaseline => ({ [event.externalUid!]: { serverId: event.id, fingerprint: contentFingerprint(event), revision: event.revision, calendarId } });

test('fingerprints ignore instant formatting and Kordi-only fields', () => {
  assert.equal(contentFingerprint(device()), contentFingerprint(server()));
  assert.equal(contentFingerprint({ ...device(), allDay: true, startAt: '2026-09-17T00:00:00Z', endAt: '2026-09-18T00:00:00Z' }), contentFingerprint({ ...server(), allDay: true, startAt: '2026-09-17T00:00:00+00:00', endAt: '2026-09-18T00:00:00+00:00' }));
  assert.notEqual(contentFingerprint(device()), contentFingerprint(device({ title: 'Standup (moved)' })));
  const window = syncWindow(now);
  assert.ok(Date.parse(window.from) < now.getTime() && Date.parse(window.to) > now.getTime());
});

test('a new device event is pushed once and an unchanged pair is only settled', () => {
  const fresh = planCalendarSync({ device: [device()], server: [], baseline: {}, now });
  assert.equal(fresh.upserts.length, 1);
  assert.equal(fresh.upserts[0].revision, 0);
  assert.equal(fresh.upserts[0].externalUid, 'device:a');
  assert.equal(fresh.upserts[0].reminderAt, null);
  assert.equal('deviceId' in fresh.upserts[0], false);
  assert.deepEqual([fresh.deletes, fresh.deviceWrites, fresh.deviceDeletes], [[], [], []]);
  const unchanged = planCalendarSync({ device: [device()], server: [server()], baseline: {}, now });
  assert.deepEqual([unchanged.upserts, unchanged.deletes, unchanged.deviceWrites, unchanged.deviceDeletes], [[], [], [], []]);
  assert.equal(unchanged.baseline['device:a'].revision, 3);
  assert.equal(unchanged.baseline['device:a'].calendarId, 'work');
});

test('edits flow toward the side that did not change and keep Kordi-only fields', () => {
  const current = server();
  const renamedOnDevice = planCalendarSync({ device: [device({ title: 'Standup (moved)', startAt: '2026-09-17T10:00:00Z', endAt: '2026-09-17T10:30:00Z' })], server: [current], baseline: settled(current), now });
  assert.equal(renamedOnDevice.upserts.length, 1);
  assert.equal(renamedOnDevice.upserts[0].title, 'Standup (moved)');
  assert.equal(renamedOnDevice.upserts[0].startAt, '2026-09-17T10:00:00Z');
  assert.equal(renamedOnDevice.upserts[0].revision, 3, 'updates carry the expected server revision');
  assert.equal(renamedOnDevice.upserts[0].reminderAt, current.reminderAt, 'the Kordi reminder survives a device edit');
  assert.equal(renamedOnDevice.deviceWrites.length, 0);
  const renamedInKordi = server({ title: 'Standup with design', revision: 4 });
  const toDevice = planCalendarSync({ device: [device()], server: [renamedInKordi], baseline: settled(current), now });
  assert.equal(toDevice.upserts.length, 0);
  assert.equal(toDevice.deviceWrites.length, 1);
  assert.equal(toDevice.deviceWrites[0].deviceId, 'ek-a');
  assert.equal(toDevice.deviceWrites[0].event.title, 'Standup with design');
  const reminderOnly = server({ revision: 4 });
  const quiet = planCalendarSync({ device: [device()], server: [reminderOnly], baseline: settled(current), now });
  assert.deepEqual([quiet.upserts, quiet.deviceWrites], [[], []]);
  assert.equal(quiet.baseline['device:a'].revision, 4);
});

test('when both sides changed the most recent edit wins', () => {
  const current = server();
  const deviceWins = planCalendarSync({ device: [device({ title: 'Device title', modifiedAt: '2026-09-16T11:00:00Z' })], server: [server({ title: 'Kordi title', revision: 4, updatedAt: '2026-09-16T10:00:00Z' })], baseline: settled(current), now });
  assert.equal(deviceWins.upserts[0]?.title, 'Device title');
  const serverWins = planCalendarSync({ device: [device({ title: 'Device title', modifiedAt: '2026-09-16T09:00:00Z' })], server: [server({ title: 'Kordi title', revision: 4, updatedAt: '2026-09-16T10:00:00Z' })], baseline: settled(current), now });
  assert.equal(serverWins.upserts.length, 0);
  assert.equal(serverWins.deviceWrites[0]?.event.title, 'Kordi title');
  const unknownTimes = planCalendarSync({ device: [device({ title: 'Device title', modifiedAt: null })], server: [server({ title: 'Kordi title', revision: 4, updatedAt: null })], baseline: {}, now });
  assert.equal(unknownTimes.upserts[0]?.title, 'Device title');
});

test('deletions propagate only for events this device settled before', () => {
  const current = server();
  const removedOnDevice = planCalendarSync({ device: [], server: [current], baseline: settled(current), now });
  assert.deepEqual(removedOnDevice.deletes.map(event => event.id), ['calendar-a']);
  assert.equal(removedOnDevice.deviceDeletes.length, 0);
  const otherDevice = planCalendarSync({ device: [], server: [server({ id: 'calendar-phone', externalUid: 'device:phone-only' })], baseline: {}, now });
  assert.deepEqual([otherDevice.deletes, otherDevice.deviceWrites], [[], []], 'another device’s calendar is left alone');
  const removedInKordi = planCalendarSync({ device: [device()], server: [], baseline: settled(current), now });
  assert.deepEqual(removedInKordi.deviceDeletes, [{ deviceId: 'ek-a', externalUid: 'device:a', startAt: '2026-09-17T09:00:00Z' }]);
  assert.equal(removedInKordi.upserts.length, 0, 'a Kordi removal is not re-imported');
  const ics = server({ id: 'ics-1', externalUid: 'feed-uid' });
  const untouched = planCalendarSync({ device: [], server: [ics], baseline: {}, now });
  assert.deepEqual([untouched.deletes, untouched.deviceWrites], [[], []]);
});

test('Kordi-created events are claimed before they are copied to the device, and follow later removals', () => {
  const created = server({ id: 'digest-1', externalUid: null, revision: 1, sourceIds: ['m1'] });
  const plan = planCalendarSync({ device: [], server: [created], baseline: {}, outbound: { enabled: true, calendarId: 'personal' }, installationId: 'mac-1', now });
  assert.deepEqual(plan.claims.map(event => event.id), ['digest-1'], 'the device claims the event instead of writing it straight away');
  assert.equal(plan.deviceWrites.length, 0);
  assert.equal(planCalendarSync({ device: [], server: [created], baseline: {}, now }).claims.length, 0, 'no installation id, no claim');
  const disabled = planCalendarSync({ device: [], server: [created], baseline: {}, outbound: { enabled: false }, installationId: 'mac-1', now });
  assert.equal(disabled.claims.length, 0);
  const farAway = planCalendarSync({ device: [], server: [server({ id: 'digest-2', externalUid: null, revision: 1, startAt: '2028-01-01T09:00:00Z', endAt: '2028-01-01T09:30:00Z' })], baseline: {}, installationId: 'mac-1', now });
  assert.equal(farAway.claims.length, 0);
  const draft = planCalendarSync({ device: [], server: [server({ id: 'digest-3', externalUid: null, revision: 0 })], baseline: {}, installationId: 'mac-1', now });
  assert.equal(draft.claims.length, 0);
  // A claim this installation made in an unfinished pass is completed; another installation's claim is left to it.
  const ownClaim = planCalendarSync({ device: [], server: [{ ...created, externalUid: 'claim:mac-1', revision: 2 }], baseline: {}, outbound: { enabled: true, calendarId: 'personal' }, installationId: 'mac-1', now });
  assert.equal(ownClaim.deviceWrites.length, 1);
  assert.equal(ownClaim.deviceWrites[0].calendarId, 'personal');
  assert.equal(ownClaim.deviceWrites[0].deviceId, undefined);
  const otherClaim = planCalendarSync({ device: [], server: [{ ...created, externalUid: 'claim:phone-1', revision: 2 }], baseline: {}, installationId: 'mac-1', now });
  assert.deepEqual([otherClaim.claims, otherClaim.deviceWrites, otherClaim.deletes], [[], [], []]);
  // Written to the device earlier (baseline points at it), now missing there: the user deleted it in the device calendar.
  const written: SyncBaseline = { 'device:new': { serverId: 'digest-1', fingerprint: contentFingerprint(created), revision: 1, calendarId: 'personal' } };
  const gone = planCalendarSync({ device: [], server: [created], baseline: written, now });
  assert.deepEqual(gone.deletes.map(event => event.id), ['digest-1']);
  assert.equal(gone.deviceWrites.length, 0);
  // Adoption completed: the device copy carries the identity, the server row does not yet.
  const adoption = planCalendarSync({ device: [device({ id: 'calendar-new', externalUid: 'device:new', deviceId: 'ek-new', calendarId: 'personal', startAt: created.startAt, endAt: created.endAt })], server: [created], baseline: written, now });
  assert.equal(adoption.upserts.length, 1);
  assert.equal(adoption.upserts[0].id, 'digest-1');
  assert.equal(adoption.upserts[0].externalUid, 'device:new');
  assert.equal(adoption.upserts[0].revision, 1);
});

test('rows from the earlier start-time import are adopted instead of duplicated', () => {
  const legacy = server({ externalUid: 'device:a:2026-09-17T09:00:00Z' });
  const plan = planCalendarSync({ device: [device()], server: [legacy], baseline: {}, now });
  assert.equal(plan.upserts.length, 1);
  assert.equal(plan.upserts[0].id, 'calendar-a');
  assert.equal(plan.upserts[0].externalUid, 'device:a');
  assert.equal(plan.upserts[0].revision, 3);
  assert.equal(plan.deletes.length, 0);
  const recurring = server({ id: 'calendar-r', externalUid: 'device:r:2026-09-17T09:00:00Z' });
  const occurrence = planCalendarSync({ device: [device({ id: 'calendar-r-occ', externalUid: 'device:r:occurrence:1789030800', deviceId: 'ek-r' })], server: [recurring], baseline: {}, now });
  assert.equal(occurrence.upserts.length, 1);
  assert.equal(occurrence.upserts[0].id, 'calendar-r');
  assert.equal(occurrence.upserts[0].externalUid, 'device:r:occurrence:1789030800');
});

test('excluding a calendar removes only the copies this device synced', () => {
  const current = server();
  const excluded = planCalendarSync({ device: [device()], server: [current], baseline: settled(current), excludedCalendarIds: ['work'], now });
  assert.deepEqual(excluded.deletes.map(event => event.id), ['calendar-a']);
  assert.equal(excluded.deviceDeletes.length, 0, 'the source calendar is never modified');
  assert.equal(excluded.baseline['device:a'], undefined);
  const neverSynced = planCalendarSync({ device: [device()], server: [current], baseline: {}, excludedCalendarIds: ['work'], now });
  assert.deepEqual([neverSynced.deletes, neverSynced.upserts], [[], []]);
  const excludedNew = planCalendarSync({ device: [device()], server: [], baseline: {}, excludedCalendarIds: ['work'], now });
  assert.equal(excludedNew.upserts.length, 0);
});

test('one device identity reported twice collapses to a single upsert', () => {
  const inWork = device({ deviceId: 'ek-work', calendarId: 'work', modifiedAt: '2026-09-16T09:00:00Z' });
  const inShared = device({ deviceId: 'ek-shared', calendarId: 'shared', title: 'Standup (shared copy)', modifiedAt: '2026-09-16T11:00:00Z' });
  const plan = planCalendarSync({ device: [inWork, inShared], server: [], baseline: {}, now });
  assert.equal(plan.upserts.length, 1);
  assert.equal(plan.upserts[0].title, 'Standup (shared copy)', 'the most recently modified copy wins');
  const excludedShared = planCalendarSync({ device: [inShared, inWork], server: [], baseline: {}, excludedCalendarIds: ['shared'], now });
  assert.equal(excludedShared.upserts.length, 1);
  assert.equal(excludedShared.upserts[0].title, 'Standup', 'a copy in a synced calendar beats one in an excluded calendar');
  const ids = new Set(plan.upserts.map(event => event.id));
  assert.equal(ids.size, plan.upserts.length);
});

test('an event removed in Kordi stays removed while its device copy cannot be deleted', () => {
  const current = server();
  const first = planCalendarSync({ device: [device()], server: [], baseline: settled(current), now });
  assert.deepEqual(first.deviceDeletes, [{ deviceId: 'ek-a', externalUid: 'device:a', startAt: '2026-09-17T09:00:00Z' }]);
  assert.equal(first.upserts.length, 0);
  assert.equal(first.baseline['device:a']?.suppressed, true, 'the identity is remembered as removed');
  // The device copy is still there next pass (read-only calendar, or a second copy of the same invitation).
  const second = planCalendarSync({ device: [device({ deviceId: 'ek-other' })], server: [], baseline: first.baseline, now });
  assert.equal(second.upserts.length, 0, 'not re-imported');
  assert.equal(second.deviceDeletes.length, 0, 'not retried every pass');
  assert.equal(second.baseline['device:a']?.suppressed, true);
  // Once the device copy is gone the identity is forgotten, so a future re-creation syncs normally.
  const third = planCalendarSync({ device: [], server: [], baseline: second.baseline, now });
  assert.equal(third.baseline['device:a'], undefined);
  // If the event is re-added in Kordi (server has it again) the suppression ends.
  const readded = planCalendarSync({ device: [device()], server: [current], baseline: second.baseline, now });
  assert.equal(readded.baseline['device:a']?.suppressed, undefined);
});

test('repeating occurrences carry their device start, and read-only calendars are never written', () => {
  const current = server({ id: 'calendar-r', externalUid: 'device:r:occurrence:1789030800', title: 'Weekly', revision: 2 });
  const occurrence = device({ id: 'calendar-r', externalUid: 'device:r:occurrence:1789030800', deviceId: 'ek-r', title: 'Weekly', startAt: '2026-09-17T11:00:00Z', endAt: '2026-09-17T11:30:00Z' });
  const baseline = settled(occurrence as CalendarEvent);
  const moved = planCalendarSync({ device: [occurrence], server: [{ ...current, startAt: '2026-09-17T12:00:00Z', endAt: '2026-09-17T12:30:00Z' }], baseline, now });
  assert.equal(moved.deviceWrites.length, 1);
  assert.equal(moved.deviceWrites[0].deviceStartAt, '2026-09-17T11:00:00Z', 'the write targets the occurrence where it is now');
  assert.equal(moved.deviceWrites[0].event.externalUid, 'device:r:occurrence:1789030800');
  const removed = planCalendarSync({ device: [occurrence], server: [], baseline, now });
  assert.deepEqual(removed.deviceDeletes, [{ deviceId: 'ek-r', externalUid: 'device:r:occurrence:1789030800', startAt: '2026-09-17T11:00:00Z' }]);
  const birthday = device({ id: 'calendar-b', externalUid: 'device:b', deviceId: 'ek-b', calendarId: 'birthdays', title: 'Birthday' });
  const birthdayBaseline = settled({ ...birthday, revision: 1 } as CalendarEvent, 'birthdays');
  const readOnlyRemoval = planCalendarSync({ device: [birthday], server: [], baseline: birthdayBaseline, readOnlyCalendarIds: ['birthdays'], now });
  assert.deepEqual(readOnlyRemoval.deviceDeletes, [], 'no device delete is attempted in a read-only calendar');
  assert.equal(readOnlyRemoval.upserts.length, 0, 'and the event still stays removed from Kordi');
  assert.equal(readOnlyRemoval.baseline['device:b']?.suppressed, true);
  const readOnlyEdit = planCalendarSync({ device: [birthday], server: [server({ id: 'calendar-b', externalUid: 'device:b', title: 'Birthday (renamed in Kordi)', revision: 2 })], baseline: birthdayBaseline, readOnlyCalendarIds: ['birthdays'], now });
  assert.deepEqual([readOnlyEdit.deviceWrites, readOnlyEdit.upserts], [[], []]);
});

test('meeting notes with HTML are shown as plain text', async () => {
  const { plainEventNotes } = await import('../src/features/digest/calendar');
  assert.equal(plainEventNotes('Plain note\nsecond line'), 'Plain note\nsecond line');
  assert.equal(plainEventNotes('<p>Join Zoom<br/>64.211.144.160 (Brazil)<br>Meeting ID: 929&nbsp;2747</p><br>———</p>'), 'Join Zoom\n64.211.144.160 (Brazil)\nMeeting ID: 929 2747\n\n———');
  assert.equal(plainEventNotes('<ul><li>One</li><li>Two &amp; three</li></ul>'), '• One\n• Two & three');
});

test('a row owned by another device keeps its identity, so two devices never trade it back and forth', () => {
  const owned = server({ id: 'digest-1', externalUid: 'device:phone-copy', revision: 5 });
  const mine: SyncBaseline = { 'device:mac-copy': { serverId: 'digest-1', fingerprint: contentFingerprint(owned), revision: 4, calendarId: 'work' } };
  const macCopy = device({ id: 'calendar-mac', externalUid: 'device:mac-copy', deviceId: 'ek-mac', title: owned.title, startAt: owned.startAt, endAt: owned.endAt });
  const same = planCalendarSync({ device: [macCopy], server: [owned], baseline: mine, installationId: 'mac-1', now });
  assert.deepEqual(same.upserts, [], 'no identity change is proposed');
  assert.equal(same.baseline['device:mac-copy']?.serverId, 'digest-1');
  const edited = planCalendarSync({ device: [{ ...macCopy, title: 'Renamed on the Mac' }], server: [owned], baseline: mine, installationId: 'mac-1', now });
  assert.equal(edited.upserts.length, 1);
  assert.equal(edited.upserts[0].externalUid, 'device:phone-copy', 'content flows, ownership stays');
  assert.equal(edited.deviceUidByServerId['digest-1'], 'device:mac-copy', 'the baseline is still keyed by this device copy');
});
