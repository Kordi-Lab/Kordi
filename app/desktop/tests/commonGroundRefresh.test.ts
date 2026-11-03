import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CommonGroundError } from '../src/features/commonGround/client';
import { CommonGroundStore, SYNC_INTERVAL_MS } from '../src/features/commonGround/store';
import { mockServer, owner, person, room } from './helpers/commonGroundServer';

const ready = { status: 'ready' as const, people: [], topics: [], suggestion: null };
const match = { person: person('peer'), status: 'ready' as const, score: 80, headline: 'Shared work', shared: [], youBring: [], theyBring: [] };

test('ready room results and roster refresh without reopening', async () => {
  const { client } = mockServer({
    'GET card': { status: 200, body: owner() },
    'GET rooms': { status: 200, body: { rooms: [{ code: '4821' }] } },
    'GET rooms/4821': { status: 200, body: room('4821', { members: [person('self'), person('peer')] }) },
    'POST rooms/4821/results': { status: 200, body: { ...ready, people: [{ person: person('peer'), score: 80, headline: 'New result' }] } },
  });
  const store = new CommonGroundStore(client);
  store.set({ loaded: true, owner: owner(), stack: [{ name: 'home' }, { name: 'results', code: '4821' }], results: { '4821': ready }, rooms: { '4821': room('4821') } });
  await store.syncFromServer(Date.now() + SYNC_INTERVAL_MS);
  assert.equal(store.getSnapshot().rooms['4821'].members.length, 2);
  assert.equal(store.getSnapshot().results['4821'].people.length, 1);
});

test('fresh sharing withdrawal replaces a loaded ready match and clears private cached cards', async () => {
  const { client } = mockServer({
    'GET card': { status: 200, body: owner({ sharing: false }) },
    'GET rooms': { status: 200, body: { rooms: [] } },
    'POST match/peer': { status: 200, body: { ...match, status: 'hidden', score: null, headline: null } },
  });
  // The client route is stubbed here to isolate cache reconciliation from transport formatting.
  client.match = async () => ({ ...match, status: 'hidden', score: null, headline: null });
  const store = new CommonGroundStore(client);
  store.set({ loaded: true, owner: owner(), stack: [{ name: 'home' }, { name: 'match', accountId: 'peer' }], matches: { peer: match }, rooms: { '4821': room('4821') }, results: { '4821': ready } });
  await store.syncFromServer(Date.now() + SYNC_INTERVAL_MS);
  assert.equal(store.getSnapshot().owner?.sharing, false);
  assert.equal(store.getSnapshot().matches.peer.status, 'hidden');
  assert.deepEqual(store.getSnapshot().results, {});
  assert.deepEqual(store.getSnapshot().rooms, {});
});

test('a revoked room clears loaded results; a transient match failure preserves them', async () => {
  const { client } = mockServer({});
  client.results = async () => { throw new CommonGroundError('Room not found.', 404, 'common_ground_room_not_found'); };
  client.match = async () => { throw new CommonGroundError('Unavailable', 503, 'server_error'); };
  const store = new CommonGroundStore(client);
  store.set({ loaded: true, owner: owner(), stack: [{ name: 'home' }, { name: 'results', code: '4821' }], results: { '4821': ready }, rooms: { '4821': room('4821') }, matches: { peer: match } });
  await store.loadScreen();
  assert.deepEqual(store.getSnapshot().results, {});
  assert.deepEqual(store.getSnapshot().rooms, {});
  assert.equal(store.top().name, 'home');
  await store.loadScreen({ name: 'match', accountId: 'peer' });
  assert.equal(store.getSnapshot().matches.peer, match);
});

test('a card poll for the previous profile cannot overwrite the selected card', async () => {
  const { client } = mockServer({});
  let finish!: (value: ReturnType<typeof owner>) => void;
  client.card = () => new Promise((resolve) => { finish = resolve; });
  const store = new CommonGroundStore(client);
  store.set({ profileId: 'old', owner: owner({ build: { status: 'building', errorCode: null } }) });
  const pending = store.poll();
  const selected = owner({ card: null });
  store.set({ profileId: 'selected', owner: selected });
  finish(owner());
  await pending;
  assert.equal(store.getSnapshot().owner, selected);
});

test('polling resumes pending work immediately on focus and stops after unmount', async () => {
  const { startCommonGroundPolling } = await import('../src/features/commonGround/polling');
  const win = new EventTarget();
  const doc = Object.assign(new EventTarget(), { hidden: true });
  let callback: (() => void) | undefined;
  let polls = 0;
  const stop = startCommonGroundPolling(async () => { polls += 1; return 3_000; }, {
    win, doc,
    schedule: (run) => { callback = run; return 1 as unknown as ReturnType<typeof setTimeout>; },
    cancel: () => { callback = undefined; },
  });
  callback!();
  assert.equal(polls, 0);
  doc.hidden = false;
  win.dispatchEvent(new Event('focus'));
  await Promise.resolve();
  assert.equal(polls, 1, 'does not wait for a background timer');
  stop();
  win.dispatchEvent(new Event('focus'));
  assert.equal(polls, 1);
  assert.equal(callback, undefined);
});

test('source instants and card build dates share the local day while date-only sources stay unchanged', async () => {
  const { shortDay } = await import('../src/features/commonGround/wallet');
  const { refMeta, seenLine } = await import('../src/features/commonGround/cardReferences');
  const previous = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  try {
    const at = '2026-11-02T01:30:00+00:00';
    const card = owner().card!;
    assert.equal(shortDay(at, new Date('2026-11-03T12:00:00Z')), '1 Nov');
    assert.match(refMeta({ source: 'Notes', title: 'Synthetic note', snippet: 'Test', date: at, url: null }).rest, /1 Nov/);
    assert.match(seenLine({ ...card, profile: { topics: { Test: { refs: [], firstSeen: at, lastSeen: at } } } }, 'Test'), /Seen 1 Nov/);
    assert.equal(shortDay('2026-11-02', new Date('2026-11-03T12:00:00Z')), '2 Nov');
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});
