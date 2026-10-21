import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { HomeScreen } from '../src/features/commonGround/HomeScreen';
import type { CgHost } from '../src/features/commonGround/host';
import { personTitle, pickProfile, sharePreselect, type CgProfileMemory } from '../src/features/commonGround/profiles';
import { CommonGroundStore } from '../src/features/commonGround/store';
import type { CgProfile } from '../src/features/commonGround/types';

import { mockServer, owner } from './helpers/commonGroundServer';

const profile = (profileId: string, kind: CgProfile['kind'], name: string, hasCard: boolean): CgProfile => (
  { profileId, kind, name, focus: null, position: 0, hasCard, sharing: true, builtAt: null, topicCount: hasCard ? 5 : 0 }
);
const work = profile('cgp_work', 'work', 'Work', true);
const health = profile('cgp_health', 'health', 'Health', false);
const memory = (saved: string | null = null) => {
  const box = { saved };
  const store: CgProfileMemory = { read: () => box.saved, write: (id) => { box.saved = id; } };
  return { box, store };
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const selfHost = { self: { accountId: 'me', name: 'Me', avatarUrl: null } } as unknown as CgHost;

test('profiles: the saved current profile is restored, sent as ?profile= and saved on switch', async () => {
  const { calls, client } = mockServer({
    'GET profiles': { status: 200, body: { profiles: [work, health] } },
    'GET card?profile=cgp_health': { status: 200, body: owner({ card: null }) },
    'GET card?profile=cgp_work': { status: 200, body: owner() },
    'GET recent': { status: 200, body: { people: [] } },
    'GET rooms': { status: 200, body: { rooms: [] } },
  });
  const saved = memory('cgp_health');
  const store = new CommonGroundStore(client, { profiles: true, memory: saved.store });
  await store.loadHome();
  assert.equal(store.getSnapshot().profileId, 'cgp_health');
  assert.ok(calls.some((call) => call.url.endsWith('/card?profile=cgp_health')));
  await store.selectProfile('cgp_work');
  assert.equal(saved.box.saved, 'cgp_work');
  assert.deepEqual(store.getSnapshot().owner?.card?.workingOn, ['Agent memory']);
  assert.equal(pickProfile([work, health], 'gone'), 'cgp_work');
  assert.equal(pickProfile([health], null), 'cgp_health');
});

test('profiles: create, rename and delete send the documented requests', async () => {
  const kaust = { ...profile('cgp_kaust', 'custom', 'KAUST', false), focus: 'My research group at KAUST' };
  const { calls, client } = mockServer({
    'POST profiles': { status: 201, body: kaust },
    'PUT profiles/cgp_kaust': { status: 200, body: { ...kaust, name: 'Lab' } },
    'DELETE profiles/cgp_kaust': { status: 204 },
    'GET card?profile=cgp_kaust': { status: 200, body: owner({ card: null }) },
    'GET profiles': { status: 200, body: { profiles: [work] } },
    'GET card?profile=cgp_work': { status: 200, body: owner() },
  });
  const saved = memory();
  const store = new CommonGroundStore(client, { profiles: true, memory: saved.store });
  store.set({ profiles: [work], profileId: 'cgp_work' });
  assert.equal(await store.createProfile({ kind: 'custom', name: ' KAUST ', focus: 'My research group at KAUST' }), true);
  assert.deepEqual(calls[0].body, { kind: 'custom', name: 'KAUST', focus: 'My research group at KAUST' });
  assert.equal(store.getSnapshot().profileId, 'cgp_kaust');
  assert.equal(saved.box.saved, 'cgp_kaust');
  assert.deepEqual(store.top(), { name: 'build' });
  await store.updateProfile('cgp_kaust', { name: 'Lab' });
  assert.deepEqual(calls.find((call) => call.method === 'PUT')?.body, { name: 'Lab' });
  assert.equal(store.getSnapshot().profiles[1].name, 'Lab');
  assert.equal(await store.deleteProfile('cgp_kaust'), true);
  assert.ok(calls.some((call) => call.method === 'DELETE' && call.url.endsWith('/profiles/cgp_kaust')));
  assert.equal(store.getSnapshot().profileId, 'cgp_work');
  assert.equal(saved.box.saved, 'cgp_work');
  assert.deepEqual(store.top(), { name: 'home' });
});

test('profiles: build, topics, hidden and sharing act on the current profile', async () => {
  const { calls, client } = mockServer({
    'POST card/build': { status: 202, body: owner({ card: null, build: { status: 'building', errorCode: null } }) },
    'PUT card?profile=cgp_health': { status: 200, body: owner() },
    'PUT card/hidden': { status: 200, body: owner() },
    'PUT settings': { status: 200, body: owner() },
  });
  const store = new CommonGroundStore(client, { profiles: true });
  store.set({ profiles: [work, health], profileId: 'cgp_health', owner: owner() });
  await store.build({ memory: false, connectors: false, device: [], links: '', notes: 'x' });
  assert.deepEqual(calls[0].body, { memory: false, connectors: false, device: [], links: '', notes: 'x', profileId: 'cgp_health' });
  store.set({ owner: owner() });
  await store.saveTopics({ workingOn: ['A'], interests: [], canHelp: [], lookingFor: [] });
  await store.toggleHidden('Agent memory');
  await store.setSharing(false);
  assert.ok(calls[1].url.endsWith('/card?profile=cgp_health'));
  assert.deepEqual(calls[2].body, { hidden: ['Agent memory'], profileId: 'cgp_health' });
  assert.deepEqual(calls[3].body, { sharing: false, profileId: 'cgp_health' });
});

test('profiles: join sends the profile, kind and name; Change calls the switch route', async () => {
  const room = { roomId: 'r', code: '4821', name: 'Clinic', openedByYou: true, expiresAt: '', members: [], kind: 'health', profileId: 'cgp_health' };
  const { calls, client } = mockServer({
    'POST rooms/4821/join': { status: 200, body: room },
    'POST rooms/4821/profile': { status: 200, body: { ...room, profileId: 'cgp_work' } },
    'GET rooms': { status: 200, body: { rooms: [] } },
  });
  const store = new CommonGroundStore(client, { profiles: true });
  assert.equal(await store.joinRoom('4821', { profileId: 'cgp_health', kind: 'health', name: ' Clinic ' }), true);
  assert.deepEqual(calls[0].body, { name: 'Clinic', kind: 'health', profileId: 'cgp_health' });
  store.set({ results: { 4821: { status: 'ready', people: [], topics: [], suggestion: null } } });
  assert.equal(await store.switchRoomProfile('4821', 'cgp_work'), true);
  const switched = calls.find((call) => call.url.endsWith('/rooms/4821/profile'));
  assert.deepEqual(switched?.body, { profileId: 'cgp_work' });
  assert.equal(store.getSnapshot().rooms['4821'].profileId, 'cgp_work');
  assert.equal(store.getSnapshot().results['4821'], undefined);
});

test('profiles: the Share sheet preselects the room kind, and people show a profile other than Work', () => {
  const healthBuilt = { ...health, hasCard: true };
  assert.equal(sharePreselect([work, healthBuilt], { kind: 'health', current: 'cgp_work' }), 'cgp_health');
  assert.equal(sharePreselect([work, health], { kind: 'health', current: 'cgp_work' }), 'cgp_work');
  assert.equal(sharePreselect([work, healthBuilt], { current: 'cgp_health' }), 'cgp_health');
  assert.equal(personTitle({ name: 'Nadia', profile: { profileId: 'p', kind: 'health', name: 'Health' } }), 'Nadia · Health');
  assert.equal(personTitle({ name: 'Nadia', profile: { profileId: 'p', kind: 'work', name: 'Work' } }), 'Nadia');
  assert.equal(personTitle({ name: 'Nadia' }), 'Nadia');
});

test('profiles: Home shows the switcher and the Build row; version 1 shows neither', async () => {
  const { client } = mockServer({
    'GET profiles': { status: 200, body: { profiles: [work, health] } },
    'GET card?profile=cgp_health': { status: 200, body: owner({ card: null }) },
    'GET card': { status: 200, body: owner() },
    'GET recent': { status: 200, body: { people: [] } },
  });
  const store = new CommonGroundStore(client, { profiles: true, memory: memory('cgp_health').store });
  await store.loadHome();
  const html = renderToStaticMarkup(createElement(HomeScreen, { state: store.getSnapshot(), store, host: selfHost }));
  assert.match(html, /aria-label="Profiles"/);
  assert.match(html, />Work</);
  assert.match(html, /Build your Health profile/);
  assert.match(html, /aria-label="New profile"/);
  const { calls, client: oldClient } = mockServer({ 'GET card': { status: 200, body: owner() }, 'GET recent': { status: 200, body: { people: [] } } });
  const old = new CommonGroundStore(oldClient);
  await old.loadHome();
  await tick();
  assert.equal(calls.some((call) => call.url.includes('profiles') || call.url.includes('?profile=')), false);
  const oldHtml = renderToStaticMarkup(createElement(HomeScreen, { state: old.getSnapshot(), store: old, host: selfHost }));
  assert.doesNotMatch(oldHtml, /Profiles|New profile|Sharing:/);
  const missing = new CommonGroundStore(mockServer({ 'GET card': { status: 200, body: owner() } }).client, { profiles: true });
  await missing.loadHome();
  assert.equal(missing.getSnapshot().profilesOn, false);
});
