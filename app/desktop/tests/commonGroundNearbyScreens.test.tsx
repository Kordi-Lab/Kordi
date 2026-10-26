import assert from 'node:assert/strict';
import { test } from 'node:test';

import { act, createElement, useSyncExternalStore } from 'react';

import type { CgHost } from '../src/features/commonGround/host';
import { NearbyScreen } from '../src/features/commonGround/NearbyScreen';
import { PairCodePanel } from '../src/features/commonGround/PairCodePanel';
import { CommonGroundStore } from '../src/features/commonGround/store';

import { mockServer, owner, profile, type Reply } from './helpers/commonGroundServer';
import { installDom } from './helpers/transcriptAttachmentDom';

const work = profile('cgp_work', 'work', 'Work', true);
const workshops = profile('cgp_ws', 'custom', 'Workshops', true, { design: 'workshop' });
const health = profile('cgp_health', 'health', 'Health', false);

const fresh = () => ({ capturedAt: new Date(Date.now() - 3 * 60_000 - 5_000).toISOString(), freshUntil: new Date(Date.now() + 27 * 60_000).toISOString(), fresh: true });
const settings = (patch: Record<string, unknown> = {}) => ({
  enabled: true, participating: true, pausedUntil: null, consentedAt: '2026-10-26T09:00:00Z', profileId: 'cgp_work', openTo: ['Coffee chat'],
  range: 2000, minScore: 0, alerts: { requests: true, matches: true, matchMinScore: 85, maxPerDay: 3 }, location: fresh(), freshSeconds: 1800, ...patch,
});
const maya = {
  person: { accountId: 'acct_maya', name: 'Maya Chen', avatarUrl: null, profile: { profileId: 'cgp_maya', kind: 'work', name: 'Work' } },
  relationship: { contact: false, request: null, requestId: null, conversationId: null },
  distance: { minMeters: 0, maxMeters: 500 }, openTo: ['Collaborating'], status: 'ready', score: 92, headline: 'Both build memory for agents',
  requests: [{ needId: 'cgn_1', text: 'Someone founding a startup' }],
};
const people = { people: [maya], matching: 2, location: fresh() };

const host: CgHost = {
  self: { accountId: 'acct_you', name: 'Alex Kim', avatarUrl: null },
  profiles: true,
  nearby: true,
  memoryAvailable: false,
  openChat: () => undefined,
  acceptRequest: async () => undefined,
  contactsChanged: () => undefined,
  openGroup: () => undefined,
  connectors: null,
  agentFiles: null,
  device: null,
  openUrl: () => undefined,
};

function storeWith(routes: Record<string, Reply | Reply[]>) {
  const server = mockServer(routes);
  const store = new CommonGroundStore(server.client, { profiles: true });
  store.set({ profiles: [work, workshops, health], profileId: 'cgp_work', owner: owner(), loaded: true });
  return { ...server, store };
}

function Panel({ store, nearby }: { store: CommonGroundStore; nearby: boolean }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return createElement(PairCodePanel, { state, store, nearby });
}

function Screen({ store }: { store: CommonGroundStore }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return createElement(NearbyScreen, { state, store, host });
}

const settle = () => act(async () => { for (let index = 0; index < 6; index += 1) await new Promise((resolve) => setTimeout(resolve, 0)); });

/** Mounts an element; React DOM loads after the window exists so it listens for input events. */
async function mount(element: ReturnType<typeof createElement>, run: (root: HTMLElement) => Promise<void>) {
  const installed = installDom();
  const { createRoot } = await import('react-dom/client');
  const node = document.createElement('div');
  document.body.append(node);
  const root = createRoot(node);
  try {
    await act(async () => root.render(element));
    await settle();
    await run(node);
  } finally {
    await act(async () => root.unmount());
    installed.restore();
  }
}

const click = async (element: Element | null | undefined) => {
  assert.ok(element, 'element to click');
  await act(async () => { (element as HTMLElement).click(); });
  await settle();
};
const buttonNamed = (scope: ParentNode, text: string) => [...scope.querySelectorAll('button')].find((button) => button.textContent?.trim() === text);

test('pair panel: the Nearby row shows only with the capability, and opens Nearby', async () => {
  const { store, calls } = storeWith({ 'GET nearby': { status: 200, body: settings() }, 'GET nearby/people': { status: 200, body: people } });
  await mount(createElement(Panel, { store, nearby: false }), async (root) => {
    assert.equal(root.querySelector('[data-cg-nearby]'), null);
    assert.equal(calls.length, 0, 'nothing is fetched without the capability');
    assert.ok(root.querySelector('.cg-pair-icon.is-violet'));
    assert.ok(root.querySelector('.cg-pair-icon.is-cyan'));
  });
  await mount(createElement(Panel, { store, nearby: true }), async (root) => {
    const row = root.querySelector('[data-cg-nearby]');
    assert.ok(row?.querySelector('.cg-pair-icon.is-amber'));
    assert.match(row?.textContent ?? '', /Nearby1 person · from your iPhone/);
    await click(row);
    assert.deepEqual(store.top(), { name: 'nearby' });
  });
});

test('nearby screen: Turn on asks for consent with the card and background alerts, then shows people', async () => {
  const { store, calls } = storeWith({
    'GET nearby': { status: 200, body: settings({ enabled: false, participating: false, location: null }) },
    'GET nearby/needs': { status: 200, body: { needs: [] } },
    'PUT nearby': { status: 200, body: settings({ profileId: 'cgp_ws' }) },
    'GET nearby/people': { status: 200, body: people },
  });
  store.open({ name: 'nearby' });
  await mount(createElement(Screen, { store }), async (root) => {
    assert.match(root.textContent ?? '', /See people near you who share a card\./);
    await click(buttonNamed(root, 'Turn on'));
    const dialog = document.querySelector('[role="dialog"]');
    assert.match(dialog?.textContent ?? '', /Turn on Nearby\?/);
    const cards = [...(dialog?.querySelectorAll('[role="radio"]') ?? [])].map((radio) => radio.getAttribute('aria-label'));
    assert.deepEqual(cards, ['Work', 'Workshops'], 'only built cards that share');
    await click(dialog?.querySelector('[aria-label="Workshops"]'));
    await click(dialog?.querySelector('[aria-label="Alerts in the background"]'));
    await click(buttonNamed(dialog!, 'Turn on'));
    const put = calls.find((call) => call.method === 'PUT');
    assert.deepEqual(put?.body, { enabled: true, consent: true, profileId: 'cgp_ws', pausedUntil: null, alerts: { requests: false, matches: false } });
    assert.equal(document.querySelector('[role="dialog"]'), null);
    const text = root.textContent ?? '';
    assert.match(text, /From your iPhone · 3 min ago/);
    assert.match(text, /Maya Chen/);
    assert.match(text, /92% · Under 500 m · Both build memory for agents/);
    assert.match(text, /Matching 2 more/);
    assert.match(text, /Within 2 km/);
    assert.match(text, /Any match/);
    assert.match(text, /Alerts go to your iPhone/);
  });
});

test('nearby screen: Within stores the range and searches again; Add posts a request', async () => {
  const { store, calls } = storeWith({
    'GET nearby': { status: 200, body: settings() },
    'GET nearby/needs': { status: 200, body: { needs: [] } },
    'GET nearby/people': { status: 200, body: people },
    'PUT nearby': { status: 200, body: settings({ range: 500 }) },
    'POST nearby/needs': { status: 201, body: { needId: 'cgn_2', text: 'Demo partner', range: 1000, startsAt: null, endsAt: null, paused: false, status: 'active', revision: 1 } },
  });
  store.open({ name: 'nearby' });
  await mount(createElement(Screen, { store }), async (root) => {
    await click(root.querySelector('[data-cg-nb-menu="range"]'));
    await click(buttonNamed(root, '500 m'));
    const put = calls.findIndex((call) => call.method === 'PUT');
    assert.deepEqual(calls[put].body, { range: 500 });
    assert.ok(calls.slice(put + 1).some((call) => call.url.endsWith('/nearby/people')), 'searches after storing the range');
    assert.match(root.textContent ?? '', /Within 500 m/);

    await click(buttonNamed(root, 'Add'));
    const dialog = document.querySelector('[role="dialog"]')!;
    assert.match(dialog.textContent ?? '', /New request/);
    const save = buttonNamed(dialog, 'Save')!;
    assert.equal(save.disabled, true, 'Save waits for text');
    const area = dialog.querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(area, 'Demo partner');
      area.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await click(buttonNamed(dialog, '1 km'));
    await click(buttonNamed(dialog, 'Save'));
    assert.deepEqual(calls.find((call) => call.method === 'POST')?.body, { text: 'Demo partner', range: 1000 });
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.match(root.textContent ?? '', /Demo partnerNo end · 1 km/);
  });
});

test('nearby screen: selecting a rail card opens its home without changing Nearby sharing', async () => {
  const { CommonGroundPage } = await import('../src/features/commonGround/CommonGroundPage');
  const { store, calls } = storeWith({
    'GET nearby': { status: 200, body: settings() },
    'GET nearby/needs': { status: 200, body: { needs: [] } },
    'GET nearby/people': { status: 200, body: people },
    'GET rooms': { status: 200, body: { rooms: [] } },
  });
  store.set({ owner: owner({ profile: work }) });
  let finishCard!: (value: ReturnType<typeof owner>) => void;
  store.client.card = (id) => {
    assert.equal(id, workshops.profileId);
    return new Promise((resolve) => { finishCard = resolve; });
  };
  store.open({ name: 'nearby' });
  await mount(createElement(CommonGroundPage, { store, host }), async (root) => {
    await click(root.querySelector('[aria-label="Workshops card"]'));
    assert.deepEqual(store.getSnapshot().stack, [{ name: 'home' }]);
    assert.equal(store.getSnapshot().profileId, workshops.profileId);
    assert.equal(root.querySelector('h1')?.textContent, 'Grounding');
    assert.equal(root.querySelector('.cg-deck [aria-pressed="true"]')?.getAttribute('aria-label'), 'Workshops card');
    assert.match(root.textContent ?? '', /Opening your card/);
    assert.doesNotMatch(root.textContent ?? '', /Agent memory/, 'the old card topics never appear under the new card');
    await act(async () => finishCard(owner({ profile: workshops, card: { ...owner().card!, workingOn: ['Weekend workshops'] } })));
    await settle();
    assert.match(root.querySelector('.cg-yours')?.textContent ?? '', /WorkshopsWeekend workshops/);
    assert.equal(root.querySelector('.cg-nb'), null);
    assert.equal(calls.filter((call) => call.method === 'PUT').length, 0, 'navigation does not change sharing');
  });
});

test('nearby screen: keyboard selection opens an unbuilt card home with its Build action', async () => {
  const { CommonGroundPage } = await import('../src/features/commonGround/CommonGroundPage');
  const { store, calls } = storeWith({
    'GET nearby': { status: 200, body: settings() },
    'GET nearby/needs': { status: 200, body: { needs: [] } },
    'GET nearby/people': { status: 200, body: people },
    'GET rooms': { status: 200, body: { rooms: [] } },
    'GET card?profile=cgp_health': { status: 200, body: owner({ profile: health, card: null }) },
  });
  store.open({ name: 'nearby' });
  await mount(createElement(CommonGroundPage, { store, host }), async (root) => {
    await act(async () => root.querySelector('[aria-label="Health card"]')!.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    await settle();
    assert.equal(store.top().name, 'home');
    assert.equal(store.getSnapshot().profileId, health.profileId);
    assert.match(root.textContent ?? '', /Build/);
    assert.equal(root.querySelector('.cg-nb'), null);
    assert.equal(calls.filter((call) => call.method === 'PUT').length, 0);
  });
});

test('opening Nearby from another card selects that card before searching', async () => {
  const { store, calls } = storeWith({
    'GET nearby': { status: 200, body: settings() },
    'PUT nearby': { status: 200, body: settings({ profileId: workshops.profileId }) },
    'GET nearby/people': [
      { status: 200, body: people },
      { status: 200, body: { people: [], matching: 0, location: fresh() } },
    ],
  });
  store.set({ profileId: workshops.profileId });
  await mount(createElement(Panel, { store, nearby: true }), async (root) => {
    const row = root.querySelector('[data-cg-nearby]');
    assert.match(row?.textContent ?? '', /Find people for Workshops/);
    assert.doesNotMatch(row?.textContent ?? '', /1 person nearby/);
    await click(row);
    const change = calls.findIndex((call) => call.method === 'PUT');
    assert.deepEqual(calls[change].body, { profileId: workshops.profileId });
    assert.ok(calls.slice(change + 1).some((call) => call.url.endsWith('/nearby/people')));
    assert.deepEqual(store.top(), { name: 'nearby' });
  });
});

test('a rejected card switch does not open the previous card’s Nearby results', async () => {
  const { store } = storeWith({
    'GET nearby': { status: 200, body: settings() },
    'PUT nearby': { status: 409, body: { error: { code: 'common_ground_sharing_off', message: 'Turn on sharing for this card.' } } },
    'GET nearby/people': { status: 200, body: people },
  });
  store.set({ profileId: workshops.profileId });
  await mount(createElement(Panel, { store, nearby: true }), async (root) => {
    await click(root.querySelector('[data-cg-nearby]'));
    assert.equal(store.top().name, 'home');
    assert.ok(store.getSnapshot().notice);
  });
});

test('an unbuilt selected card opens Build instead of another card’s Nearby', async () => {
  const { store, calls } = storeWith({
    'GET nearby': { status: 200, body: settings() },
    'GET nearby/people': { status: 200, body: people },
  });
  store.set({ profileId: health.profileId });
  await mount(createElement(Panel, { store, nearby: true }), async (root) => {
    await click(root.querySelector('[data-cg-nearby]'));
    assert.equal(store.top().name, 'build');
    assert.equal(calls.some((call) => call.method === 'PUT'), false);
  });
});
