import assert from 'node:assert/strict';
import { test } from 'node:test';

import { commonGroundNearbyVersionFromCapabilities } from '../src/features/cloud/commonGroundCapability';
import { ACCOUNT_HINT_EVENT_TYPES } from '../src/features/cloud/accountHintEvents';
import {
  bandLabel, evidenceLine, locationLine, nearbyPhase, nearbyRowSub, needSub, needWindowError, openToEntry, pausedLine, pauseUntil, rangePill, scorePill, windowLabel,
} from '../src/features/commonGround/nearbyFormat';
import { notifyCommonGroundNearbyEvents, subscribeNearbyHints } from '../src/features/commonGround/nearbyHints';
import { defaultNeedWindow, needDraft, needDraftError, needInput, needPatch, slotOf } from '../src/features/commonGround/nearbyRequest';
import { CommonGroundStore } from '../src/features/commonGround/store';
import { CgNearbyStore, matchingCount, NEARBY_FAST_POLL_MS, NEARBY_SLOW_POLL_MS, nearbyStoreFor } from '../src/features/commonGround/storeNearby';
import type { CgNearbySettings, CgNeed } from '../src/features/commonGround/typesNearby';
import { startNearbyPolling } from '../src/features/commonGround/useNearby';

import { mockServer } from './helpers/commonGroundServer';

const NOW = Date.now();
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
const freshLocation = () => ({ capturedAt: iso(-3 * 60_000), freshUntil: iso(27 * 60_000), fresh: true });

const settings = (patch: Partial<CgNearbySettings> = {}): CgNearbySettings => ({
  enabled: true,
  participating: true,
  pausedUntil: null,
  consentedAt: '2026-10-26T09:00:00Z',
  profileId: 'cgp_work',
  openTo: ['Coffee chat'],
  range: 2000,
  minScore: 0,
  alerts: { requests: true, matches: true, matchMinScore: 85, maxPerDay: 3 },
  location: freshLocation(),
  freshSeconds: 1800,
  ...patch,
});

const entry = (accountId: string, patch: Record<string, unknown> = {}) => ({
  person: { accountId, name: accountId, avatarUrl: null, profile: { profileId: `cgp_${accountId}`, kind: 'work', name: 'Work' } },
  relationship: { contact: false, request: null, requestId: null, conversationId: null },
  distance: { minMeters: 0, maxMeters: 500 },
  openTo: [],
  status: 'ready',
  score: 92,
  headline: 'Both build memory for agents',
  requests: [],
  ...patch,
});

const people = (list: unknown[], matching = 0) => ({ people: list, matching, location: freshLocation() });

const need = (patch: Partial<CgNeed> = {}): CgNeed => ({
  needId: 'cgn_1', text: 'Someone founding a startup', range: 2000, startsAt: null, endsAt: null, paused: false, status: 'active',
  revision: 1, createdAt: iso(-60_000), updatedAt: iso(-60_000), ...patch,
});

function nearbyFor(routes: Parameters<typeof mockServer>[0]) {
  const server = mockServer(routes);
  const opened: unknown[] = [];
  const nearby = new CgNearbyStore({ client: server.client, open: (screen) => opened.push(screen) });
  return { ...server, nearby, opened };
}

// Capability and hints

test('nearby: the capability counts only beside commonGroundVersion', () => {
  assert.equal(commonGroundNearbyVersionFromCapabilities({ commonGroundVersion: 3, commonGroundNearbyVersion: 1 }), 1);
  assert.equal(commonGroundNearbyVersionFromCapabilities({ commonGroundVersion: 3 }), null);
  assert.equal(commonGroundNearbyVersionFromCapabilities({ commonGroundNearbyVersion: 1 }), null);
  assert.equal(commonGroundNearbyVersionFromCapabilities(null), null);
});

test('nearby: both hints pass the sync mapping and reach open views once per batch', () => {
  assert.ok(ACCOUNT_HINT_EVENT_TYPES.has('common_ground.nearby.updated'));
  assert.ok(ACCOUNT_HINT_EVENT_TYPES.has('common_ground.nearby.alert'));
  let heard = 0;
  const stop = subscribeNearbyHints(() => { heard += 1; });
  notifyCommonGroundNearbyEvents([{ eventType: 'common_ground.nearby.updated' }, { eventType: 'common_ground.nearby.alert' }]);
  notifyCommonGroundNearbyEvents([{ eventType: 'common_ground.matches.updated' }]);
  stop();
  notifyCommonGroundNearbyEvents([{ eventType: 'common_ground.nearby.alert' }]);
  assert.equal(heard, 1);
});

// Client

test('nearby client: paths and bodies follow the contract', async () => {
  const { calls, client } = mockServer({
    'GET nearby': { status: 200, body: settings() },
    'PUT nearby': { status: 200, body: settings({ range: 500 }) },
    'GET nearby/people': { status: 200, body: people([entry('acct_maya', { requests: [{ needId: 'cgn_1', text: 'Someone founding a startup' }] })], 2) },
    'GET nearby/people?range=1000&minScore=50': { status: 200, body: people([]) },
    'GET nearby/people/acct_maya': { status: 200, body: { ...entry('acct_maya'), card: { workingOn: ['Founding Loom Labs'] }, profileId: 'cgp_work', requests: [] } },
    'GET nearby/needs': { status: 200, body: { needs: [need()] } },
    'POST nearby/needs': { status: 201, body: need() },
    'PUT nearby/needs/cgn_1': { status: 200, body: need({ paused: true, status: 'paused' }) },
    'DELETE nearby/needs/cgn_1': { status: 204 },
  });
  assert.equal((await client.nearby()).profileId, 'cgp_work');
  assert.equal((await client.saveNearby({ range: 500 })).range, 500);
  const results = await client.nearbyPeople();
  assert.equal(results.matching, 2);
  assert.deepEqual(results.people[0].requests, [{ needId: 'cgn_1', text: 'Someone founding a startup' }]);
  assert.equal(results.people[0].person.relationship?.contact, false, 'the relationship is folded into the person');
  await client.nearbyPeople({ range: 1000, minScore: 50 });
  const view = await client.nearbyPerson('acct_maya');
  assert.deepEqual(view.card, { workingOn: ['Founding Loom Labs'], interests: [], canHelp: [], lookingFor: [] });
  assert.equal((await client.needs()).length, 1);
  await client.createNeed({ text: '  Someone founding a startup ', range: 2000, startsAt: null, endsAt: null, paused: false });
  await client.updateNeed('cgn_1', { paused: true });
  await client.deleteNeed('cgn_1');
  const paths = calls.map((call) => `${call.method} ${call.url.replace('https://cloud.test/v1/cloud/', '')}`);
  assert.deepEqual(paths, [
    'GET common-ground/nearby',
    'PUT common-ground/nearby',
    'GET common-ground/nearby/people',
    'GET common-ground/nearby/people?range=1000&minScore=50',
    'GET common-ground/nearby/people/acct_maya',
    'GET common-ground/nearby/needs',
    'POST common-ground/nearby/needs',
    'PUT common-ground/nearby/needs/cgn_1',
    'DELETE common-ground/nearby/needs/cgn_1',
  ]);
  assert.deepEqual(calls[1].body, { range: 500 });
  assert.deepEqual(calls[6].body, { text: 'Someone founding a startup', range: 2000 });
  assert.deepEqual(calls[7].body, { paused: true });
  assert.ok(calls.every((call) => call.auth === 'Bearer tok'));
});

test('nearby client: a new account reads the documented defaults', async () => {
  const { client } = mockServer({ 'GET nearby': { status: 200, body: { enabled: false, profileId: 'cgp_work', location: null } } });
  const read = await client.nearby();
  assert.equal(read.enabled, false);
  assert.equal(read.range, 2000);
  assert.equal(read.minScore, 0);
  assert.deepEqual(read.alerts, { requests: true, matches: true, matchMinScore: 85, maxPerDay: 3 });
  assert.equal(read.location, null);
});

// Store

test('nearby store: turning on sends consent, the card and the alert choice, then searches', async () => {
  const { calls, nearby } = nearbyFor({
    'GET nearby': { status: 200, body: settings({ enabled: false, participating: false, location: null }) },
    'PUT nearby': { status: 200, body: settings() },
    'GET nearby/people': { status: 200, body: people([entry('acct_maya')]) },
  });
  await nearby.load();
  assert.equal(nearby.phase(), 'off');
  assert.equal(calls.length, 1, 'no search while Nearby is off');
  assert.equal(await nearby.turnOn('cgp_ws', false), true);
  assert.deepEqual(calls[1].body, { enabled: true, consent: true, profileId: 'cgp_ws', pausedUntil: null, alerts: { requests: false, matches: false } });
  assert.equal(nearby.phase(), 'on');
  assert.equal(nearby.getSnapshot().results?.people.length, 1);
});

test('nearby store: consent required and no card keep Nearby off; no card opens Build', async () => {
  const { nearby, opened } = nearbyFor({
    'GET nearby': { status: 200, body: settings({ enabled: false, participating: false }) },
    'PUT nearby': [
      { status: 409, body: { errorCode: 'common_ground_nearby_consent_required', message: 'Agree to Nearby first.' } },
      { status: 409, body: { errorCode: 'common_ground_no_card', message: 'Build your card first.' } },
    ],
  });
  await nearby.load();
  assert.equal(await nearby.turnOn('cgp_work', true), false);
  assert.equal(nearby.getSnapshot().notice, 'Agree to Nearby first.');
  assert.equal(nearby.phase(), 'off');
  assert.equal(await nearby.turnOn('cgp_work', true), false);
  assert.deepEqual(opened, [{ name: 'build' }]);
});

test('nearby store: pause hides People until resumed; turning off clears results', async () => {
  const until = iso(60 * 60_000);
  const { calls, nearby } = nearbyFor({
    'GET nearby': { status: 200, body: settings() },
    'GET nearby/people': { status: 200, body: people([entry('acct_maya')]) },
    'PUT nearby': [
      { status: 200, body: settings({ pausedUntil: until, participating: false, location: null }) },
      { status: 200, body: settings({ pausedUntil: null }) },
      { status: 200, body: settings({ enabled: false, participating: false, location: null }) },
    ],
  });
  await nearby.load();
  await nearby.pause(until);
  assert.deepEqual(calls[2].body, { pausedUntil: until });
  assert.equal(nearby.phase(), 'paused');
  assert.equal(nearby.getSnapshot().results, null);
  await nearby.pause(null);
  assert.deepEqual(calls[3].body, { pausedUntil: null });
  assert.equal(nearby.phase(), 'on');
  assert.equal(calls[4].url, 'https://cloud.test/v1/cloud/common-ground/nearby/people', 'resuming searches again');
  await nearby.turnOff();
  assert.deepEqual(calls[5].body, { enabled: false });
  assert.equal(nearby.phase(), 'off');
  assert.equal(nearby.getSnapshot().results, null);
});

test('nearby store: a filter change stores it, then searches with the stored settings', async () => {
  const { calls, nearby } = nearbyFor({
    'GET nearby': { status: 200, body: settings() },
    'GET nearby/people': [{ status: 200, body: people([entry('acct_maya'), entry('acct_leo')]) }, { status: 200, body: people([entry('acct_maya')]) }],
    'PUT nearby': { status: 200, body: settings({ range: 500 }) },
  });
  await nearby.load();
  const search = nearby.setFilters({ range: 500 });
  assert.equal(nearby.getSnapshot().settings?.range, 500, 'the pill changes at once');
  await search;
  assert.deepEqual(calls.slice(2).map((call) => `${call.method} ${call.url.split('/v1/cloud/common-ground/')[1]}`), ['PUT nearby', 'GET nearby/people']);
  assert.deepEqual(calls[2].body, { range: 500 });
  assert.equal(nearby.getSnapshot().results?.people.length, 1);
});

test('nearby store: a failed save puts the setting back and shows the line', async () => {
  const { nearby } = nearbyFor({
    'GET nearby': { status: 200, body: settings() },
    'GET nearby/people': { status: 200, body: people([]) },
    'PUT nearby': { status: 422, body: { errorCode: 'common_ground_nearby_invalid_settings', message: 'Pick up to 5 entries.' } },
  });
  await nearby.load();
  await nearby.setOpenTo(['A', 'B', 'C', 'D', 'E', 'F']);
  assert.deepEqual(nearby.getSnapshot().settings?.openTo, ['Coffee chat']);
  assert.equal(nearby.getSnapshot().notice, 'Pick up to 5 entries.');
});

test('nearby store: search errors set the off and no-location states', async () => {
  const { nearby } = nearbyFor({
    'GET nearby': { status: 200, body: settings() },
    'GET nearby/people': [
      { status: 409, body: { errorCode: 'common_ground_nearby_no_location', message: "Your location isn't current." } },
      { status: 409, body: { errorCode: 'common_ground_nearby_off', message: 'Turn on Nearby to see people around you.' } },
    ],
  });
  await nearby.load();
  assert.equal(nearby.phase(), 'no-phone');
  await nearby.loadPeople();
  assert.equal(nearby.phase(), 'off');
  assert.equal(nearby.getSnapshot().notice, null);
});

test('nearby store: polls every 3 s while anyone is being matched, then every 30 s', async () => {
  const { calls, nearby } = nearbyFor({
    'GET nearby': { status: 200, body: settings() },
    'GET nearby/people': [
      { status: 200, body: people([entry('acct_maya')], 2) },
      { status: 200, body: people([entry('acct_maya'), entry('acct_leo')], 0) },
    ],
    'GET nearby/people/acct_maya': [
      { status: 200, body: { ...entry('acct_maya', { status: 'matching', score: null }), card: {}, requests: [] } },
      { status: 200, body: { ...entry('acct_maya'), card: {}, requests: [] } },
    ],
  });
  await nearby.load();
  assert.equal(matchingCount(nearby.getSnapshot().results), 2);
  assert.equal(nearby.pollDelay(), NEARBY_FAST_POLL_MS);
  await nearby.poll();
  assert.equal(nearby.pollDelay(), NEARBY_SLOW_POLL_MS);
  await nearby.loadPerson('acct_maya');
  assert.equal(nearby.pollDelay('acct_maya'), NEARBY_FAST_POLL_MS);
  await nearby.poll('acct_maya');
  assert.equal(nearby.pollDelay('acct_maya'), NEARBY_SLOW_POLL_MS);
  assert.equal(calls.filter((call) => call.url.endsWith('/nearby/people')).length, 2);
});

test('nearby store: a failed match run stops the "Matching" count and the quick polling', () => {
  const nearby = new CgNearbyStore({ client: mockServer({}).client, open: () => undefined });
  nearby.set({ settings: settings(), loaded: true, results: { people: [], matching: 3, location: freshLocation() } });
  assert.equal(nearby.pollDelay(), NEARBY_FAST_POLL_MS);
  nearby.set({ results: { people: [{ ...entry('acct_x', { status: 'failed', score: null }) } as never], matching: 3, location: freshLocation() } });
  assert.equal(matchingCount(nearby.getSnapshot().results), 0);
  assert.equal(nearby.pollDelay(), NEARBY_SLOW_POLL_MS);
});

test('nearby polling: refetches only while visible and once the delay has passed', async () => {
  let polls = 0;
  let hidden = false;
  let now = 0;
  const fake = { fetchedAt: 0, pollDelay: () => NEARBY_FAST_POLL_MS, poll: async () => { polls += 1; fake.fetchedAt = now; } } as unknown as CgNearbyStore;
  const ticks: Array<() => void> = [];
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((fn: () => void) => { ticks.push(fn); return 0 as unknown as ReturnType<typeof setTimeout>; }) as typeof setTimeout;
  try {
    const stop = startNearbyPolling(fake, undefined, { hidden: () => hidden, now: () => now });
    const tick = async (at: number) => {
      now = at;
      ticks.shift()?.();
      await new Promise((resolve) => realSetTimeout(resolve, 0));
    };
    await tick(1_000);
    assert.equal(polls, 0, 'waits for the delay');
    await tick(3_000);
    assert.equal(polls, 1);
    hidden = true;
    await tick(9_000);
    assert.equal(polls, 1, 'nothing while the window is hidden');
    hidden = false;
    await tick(10_000);
    assert.equal(polls, 2);
    stop();
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});

test('nearby store: requests are added, edited and deleted in the list, then people are searched again', async () => {
  const { calls, nearby } = nearbyFor({
    'GET nearby': { status: 200, body: settings() },
    'GET nearby/people': { status: 200, body: people([]) },
    'GET nearby/needs': { status: 200, body: { needs: [need()] } },
    'POST nearby/needs': { status: 201, body: need({ needId: 'cgn_2', text: 'Coffee with a Fudan or SJTU alum' }) },
    'PUT nearby/needs/cgn_1': { status: 200, body: need({ paused: true, status: 'paused' }) },
    'DELETE nearby/needs/cgn_2': { status: 204 },
  });
  await nearby.load({ needs: true });
  assert.ok(await nearby.createNeed({ text: 'Coffee with a Fudan or SJTU alum', range: 1000, startsAt: null, endsAt: null, paused: false }));
  assert.deepEqual(nearby.getSnapshot().needs.map((item) => item.needId), ['cgn_2', 'cgn_1']);
  assert.ok(await nearby.updateNeed('cgn_1', { paused: true }));
  assert.equal(nearby.getSnapshot().needs[1].paused, true);
  assert.ok(await nearby.deleteNeed('cgn_2'));
  assert.deepEqual(nearby.getSnapshot().needs.map((item) => item.needId), ['cgn_1']);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(calls.filter((call) => call.url.endsWith('/nearby/people')).length >= 2);
});

test('nearby store: one per Grounding store, and a hint refreshes what is open', async () => {
  const { calls, client } = mockServer({
    'GET nearby': { status: 200, body: settings() },
    'GET nearby/people': { status: 200, body: people([]) },
    'GET nearby/people/acct_maya': { status: 200, body: { ...entry('acct_maya'), card: {}, requests: [] } },
  });
  const store = new CommonGroundStore(client, { profiles: true });
  const nearby = nearbyStoreFor(store);
  assert.equal(nearbyStoreFor(store), nearby);
  const unwatch = nearby.watch('acct_maya');
  await nearby.refresh();
  unwatch();
  assert.deepEqual(calls.map((call) => call.url.split('/common-ground/')[1]), ['nearby', 'nearby/people', 'nearby/people/acct_maya']);
});

test('nearby store: a person who is no longer nearby closes with the server line', async () => {
  const { nearby } = nearbyFor({
    'GET nearby/people/acct_maya': [
      { status: 200, body: { ...entry('acct_maya'), card: {}, requests: [] } },
      { status: 404, body: { errorCode: 'common_ground_person_not_found', message: 'This person is not nearby anymore.' } },
    ],
  });
  await nearby.loadPerson('acct_maya');
  assert.ok(nearby.getSnapshot().persons.acct_maya);
  await nearby.loadPerson('acct_maya');
  assert.equal(nearby.getSnapshot().persons.acct_maya, undefined);
  assert.equal(nearby.getSnapshot().personNotices.acct_maya, 'This person is not nearby anymore.');
});

// Labels

test('nearby labels: distance bands, filters and the location line', () => {
  assert.deepEqual([500, 1000, 2000, 5000, 10000, 25000].map((maxMeters) => bandLabel({ maxMeters })), [
    'Under 500 m', 'Under 1 km', '1–2 km', '2–5 km', '5–10 km', '10–25 km',
  ]);
  assert.equal(rangePill(2000), 'Within 2 km');
  assert.equal(rangePill(25000), 'Within 25 km');
  assert.equal(scorePill(0), 'Any match');
  assert.equal(scorePill(70), '70%+ match');
  assert.equal(locationLine({ capturedAt: iso(-3 * 60_000 - 5_000), freshUntil: iso(60_000), fresh: true }, NOW), 'Location updated · 3 min ago');
  assert.equal(locationLine({ capturedAt: iso(-5_000), freshUntil: iso(60_000), fresh: true }, NOW), 'Location updated · 1 min ago');
});

test('nearby labels: the phase and the Home row line', () => {
  const at = new Date(2026, 9, 26, 13, 12);
  const paused = settings({ pausedUntil: new Date(2026, 9, 26, 15, 0).toISOString(), participating: false });
  assert.equal(nearbyPhase(null, null), 'off');
  assert.equal(nearbyPhase(settings({ enabled: false }), null), 'off');
  assert.equal(nearbyPhase(paused, null, at.getTime()), 'paused');
  assert.equal(nearbyPhase(settings({ participating: false }), null), 'off');
  assert.equal(nearbyPhase(settings({ location: null }), null), 'no-phone');
  assert.equal(nearbyPhase(settings({ location: { ...freshLocation(), fresh: false } }), null), 'no-phone');
  assert.equal(nearbyPhase(settings(), 'no_location'), 'no-phone');
  assert.equal(nearbyPhase(settings(), null), 'on');
  assert.equal(nearbyRowSub('on', settings(), 4), '4 people nearby');
  assert.equal(nearbyRowSub('on', settings(), 1), '1 person nearby');
  assert.equal(nearbyRowSub('off', settings({ enabled: false }), null), 'Off');
  assert.equal(nearbyRowSub('paused', paused, null, at), 'Paused until 3:00 PM');
  assert.equal(nearbyRowSub('no-phone', settings(), null), 'Location needed');
});

test('nearby labels: pauses read as a time today, else tomorrow', () => {
  const at = new Date(2026, 9, 26, 15, 41);
  assert.equal(pausedLine(new Date(2026, 9, 26, 16, 41).toISOString(), at), 'Paused until 4:41 PM');
  assert.equal(pausedLine(pauseUntil('tomorrow', at), at), 'Paused until tomorrow');
  assert.equal(new Date(pauseUntil('tomorrow', at)).getHours(), 8);
  assert.equal(Date.parse(pauseUntil('hour', at)) - at.getTime(), 60 * 60_000);
});

test('nearby labels: requests show their window and range, Paused or Ended', () => {
  const at = new Date(2026, 9, 26, 13, 0);
  const day = (hours: number, minutes = 0, days = 0) => new Date(2026, 9, 26 + days, hours, minutes).toISOString();
  assert.equal(needSub(need(), at), 'No end · 2 km');
  assert.equal(needSub(need({ range: 1000, startsAt: day(15), endsAt: day(18) }), at), '3–6 PM today · 1 km');
  assert.equal(windowLabel(day(10), day(14), at), '10 AM–2 PM today');
  assert.equal(windowLabel(null, day(18, 30, 1), at), 'Until 6:30 PM tomorrow');
  assert.equal(windowLabel(day(22), day(2, 0, 1), at), 'Today 10 PM – tomorrow 2 AM');
  assert.equal(needSub(need({ paused: true, status: 'paused' }), at), 'Paused');
  assert.equal(needSub(need({ endsAt: day(12) }), at), 'Ended');
});

test('nearby labels: Open to entries are trimmed, unique and capped', () => {
  assert.equal(openToEntry(['Coffee chat'], '  Pair   programming '), 'Pair programming');
  assert.equal(openToEntry(['Coffee chat'], 'coffee CHAT'), null);
  assert.equal(openToEntry(['A', 'B', 'C', 'D', 'E'], 'F'), null);
  assert.equal(openToEntry([], '   '), null);
  assert.equal(openToEntry([], 'x'.repeat(40))?.length, 30);
});

// Request editor

test('request window: ends after now and within 7 days, and starts before it ends', () => {
  const at = new Date(2026, 9, 26, 13, 0);
  const hours = (count: number) => new Date(at.getTime() + count * 60 * 60_000);
  assert.equal(needWindowError(null, null, at), null);
  assert.equal(needWindowError(hours(2), hours(5), at), null);
  assert.equal(needWindowError(null, hours(-1), at), 'End the request within the next 7 days.');
  assert.equal(needWindowError(null, hours(7 * 24 + 1), at), 'End the request within the next 7 days.');
  assert.equal(needWindowError(hours(5), hours(5), at), 'Start the request before it ends.');
  assert.equal(needWindowError(hours(6), hours(5), at), 'Start the request before it ends.');
});

test('request editor: a new request posts every field; an edit sends only what changed', () => {
  const at = new Date(2026, 9, 26, 13, 20);
  const window = defaultNeedWindow(at);
  assert.deepEqual(window, { from: { date: '2026-10-26', time: '14:00' }, until: { date: '2026-10-26', time: '17:00' } });
  const fresh = { ...needDraft(null, at), text: ' Coffee with a Fudan or SJTU alum ', range: 1000, window };
  assert.equal(needDraftError(fresh, null, at), null);
  assert.deepEqual(needInput(fresh), {
    text: 'Coffee with a Fudan or SJTU alum', range: 1000, startsAt: new Date(2026, 9, 26, 14).toISOString(), endsAt: new Date(2026, 9, 26, 17).toISOString(), paused: false,
  });
  const late = { ...fresh, window: { from: window.from, until: slotOf(new Date(2026, 10, 5, 12)) } };
  assert.equal(needDraftError(late, null, at), 'End the request within the next 7 days.');

  const ended = need({ startsAt: new Date(2026, 9, 25, 10).toISOString(), endsAt: new Date(2026, 9, 25, 12).toISOString(), status: 'ended' });
  const initial = needDraft(ended, at);
  assert.equal(needDraftError({ ...initial, text: 'Someone founding a company' }, initial, at), null, 'an untouched window is not checked again');
  assert.deepEqual(needPatch({ ...initial, text: 'Someone founding a company' }, initial), { text: 'Someone founding a company' });
  assert.deepEqual(needPatch({ ...initial, window: null, paused: true }, initial), { startsAt: null, endsAt: null, paused: true });
});

test('nearby person: evidence names where it sits on the card', () => {
  const card = { workingOn: ['Founding Loom Labs'], interests: ['Agent memory'], canHelp: [], lookingFor: [] };
  const check = (patch: Record<string, unknown>) => ({ condition: 0, label: 'x', verdict: 'met' as const, kind: null, evidence: null, ...patch });
  assert.equal(evidenceLine(check({ kind: 'work', evidence: 'Founding Loom Labs' }), card), 'Working on · Founding Loom Labs');
  assert.equal(evidenceLine(check({ kind: 'interest', evidence: 'agent  memory' }), card), 'Interests · agent  memory');
  assert.equal(evidenceLine(check({ kind: 'affiliation', evidence: 'Fudan University' }), card), 'Profile · Fudan University');
  assert.equal(evidenceLine(check({ kind: 'willingness', evidence: 'Coffee chat' }), card), 'Open to · Coffee chat');
  assert.equal(evidenceLine(check({ verdict: 'unknown' }), card), 'Not shared');
});


test('nearby polling backs off after two minutes without progress and restarts after filters change', async () => {
  const { nearby } = nearbyFor({
    'GET nearby': { status: 200, body: settings() },
    'GET nearby/people': { status: 200, body: people([], 2) },
    'PUT nearby': { status: 200, body: settings({ range: 500 }) },
  });
  await nearby.load();
  assert.equal(nearby.pollDelay(), NEARBY_FAST_POLL_MS);
  assert.equal(nearby.pollDelay(undefined, Date.now() + 120_000), NEARBY_SLOW_POLL_MS);
  await nearby.setFilters({ range: 500 });
  assert.equal(nearby.pollDelay(), NEARBY_FAST_POLL_MS);
});
