import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  CARD_DESIGNS, canCreateCard, designForName, firstFreeDesign, newCardDraft, newCardInput, profileDesign, type CgDesignMemory,
} from '../src/features/commonGround/cardDesign';
import { CardScreen } from '../src/features/commonGround/CardScreen';
import { NewCardDialog } from '../src/features/commonGround/NewCardDialog';
import { ProfileCard } from '../src/features/commonGround/ProfileCard';
import { kindLabel, takenKinds } from '../src/features/commonGround/profiles';
import { CommonGroundStore } from '../src/features/commonGround/store';
import { deckCards, deckLayout, profileFace, roomPreviewLine, suggestedProfile } from '../src/features/commonGround/wallet';

import { card, mockServer, owner, profile, room } from './helpers/commonGroundServer';

const work = profile('cgp_work', 'work', 'Work', true);
const health = profile('cgp_health', 'health', 'Health', true);
const kaust = profile('cgp_kaust', 'custom', 'KAUST', true);
const book = profile('cgp_book', 'custom', 'Book club', false);
const noMemory: CgDesignMemory = { read: () => null, write: () => undefined };

test('wallet: Create a code posts name, kind and profile, and the room goes to the top of Rooms', async () => {
  const created = room('7319', { name: 'Agents meetup', openedByYou: true, kind: 'work', profileId: 'cgp_work' });
  const listed = { code: '7319', name: 'Agents meetup', open: true, memberCount: 1, kind: 'work', profileId: 'cgp_work' };
  const { calls, client } = mockServer({
    'POST rooms': { status: 201, body: created },
    'GET rooms': { status: 200, body: { rooms: [listed, { code: '1907', name: 'Reading club', open: false }] } },
  });
  const store = new CommonGroundStore(client, { profiles: true });
  store.set({ profiles: [work], profileId: 'cgp_work', roomList: [{ code: '1907', name: 'Reading club', open: false, memberCount: 3, joinedAt: '', lastActivityAt: '', themeCount: 0 }] });
  const result = await store.createRoom({ name: '  Agents   meetup ', kind: 'work', profileId: 'cgp_work' });
  assert.equal(result?.code, '7319');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, 'https://cloud.test/v1/cloud/common-ground/rooms');
  assert.deepEqual(calls[0].body, { name: 'Agents meetup', kind: 'work', profileId: 'cgp_work' });
  assert.equal(store.getSnapshot().roomList[0].code, '7319');
  assert.equal(store.getSnapshot().rooms['7319'].name, 'Agents meetup');
  assert.equal(store.getSnapshot().busy, null);
});

test('wallet: Create a code fails like a join: a notice, or Build without a card', async () => {
  const { client } = mockServer({
    'POST rooms': [
      { status: 429, body: { errorCode: 'rate_limited', message: 'Slow down.' }, headers: { 'Retry-After': '120' } },
      { status: 409, body: { errorCode: 'common_ground_no_card', message: 'Build your card first.' } },
    ],
  });
  const store = new CommonGroundStore(client, { profiles: true });
  assert.equal(await store.createRoom({ name: 'Lab', kind: 'work' }), null);
  assert.equal(store.getSnapshot().notice, 'Try again in 2 min.');
  assert.equal(await store.createRoom({ name: 'Lab', kind: 'work' }), null);
  assert.deepEqual(store.top(), { name: 'build' });
});

test('wallet: four digits open a joined room, preview an open one, or are not found', async () => {
  const { calls, client } = mockServer({
    'GET rooms/4821/preview': { status: 200, body: { code: '4821', name: 'Poster session 2026', kind: 'custom', memberCount: 14 } },
    'GET rooms/0000/preview': { status: 404, body: { errorCode: 'common_ground_room_not_found', message: 'Room not found.' } },
  });
  const store = new CommonGroundStore(client, { profiles: true });
  store.set({ roomList: [{ code: '3907', name: 'Lab lunch', open: true, memberCount: 5, joinedAt: '', lastActivityAt: '', themeCount: 0 }] });
  assert.deepEqual(await store.lookUpCode('3907'), { status: 'joined', code: '3907' });
  assert.equal(calls.length, 0);
  assert.deepEqual(await store.lookUpCode('4821'), { status: 'preview', room: { code: '4821', name: 'Poster session 2026', kind: 'custom', memberCount: 14 } });
  assert.deepEqual(await store.lookUpCode('0000'), { status: 'missing', code: '0000' });
  // A server without the preview route shows the code alone and joins as before.
  assert.deepEqual(await store.lookUpCode('5555'), { status: 'preview', room: { code: '5555', name: '', kind: null, memberCount: null } });
});

test('wallet: the join row suggests a built card of the room kind and names kind and people', () => {
  const workshops = profile('cgp_ws', 'custom', 'Workshops', true);
  assert.equal(suggestedProfile([work, workshops], 'custom', 'cgp_work')?.profileId, 'cgp_ws');
  assert.equal(suggestedProfile([work, workshops], 'work', 'cgp_work'), null);
  assert.equal(suggestedProfile([work, { ...health, hasCard: false }], 'health', 'cgp_work'), null);
  assert.equal(suggestedProfile([work], null, 'cgp_work'), null);
  assert.equal(roomPreviewLine({ kind: 'health', memberCount: 8 }, kindLabel), 'Health · 8 people');
  assert.equal(roomPreviewLine({ kind: null, memberCount: 1 }, kindLabel), '1 person');
  assert.equal(roomPreviewLine({ kind: null, memberCount: null }, kindLabel), '');
});

test('wallet: New card starts on a free design, pre-fills Workshop and Research group, and refuses kinds in the wallet', () => {
  const taken = takenKinds([work, health, kaust]);
  assert.deepEqual(taken, ['work', 'health']);
  assert.equal(firstFreeDesign(taken), 'daily');
  assert.deepEqual(CARD_DESIGNS.map((entry) => entry.design), ['work', 'health', 'daily', 'workshop', 'research', 'custom']);
  const workshop = newCardDraft('workshop');
  assert.equal(workshop.name, 'Workshop');
  assert.equal(newCardDraft('research', workshop).name, 'Research group');
  assert.equal(newCardDraft('custom', { design: 'research', name: 'KAUST', focus: 'Vision' }).name, 'KAUST');
  assert.equal(canCreateCard(newCardDraft('work'), taken), false);
  assert.equal(canCreateCard(newCardDraft('daily'), taken), true);
  assert.equal(canCreateCard(newCardDraft('custom'), taken), false);
  assert.equal(canCreateCard({ design: 'custom', name: ' Book club ', focus: '' }, taken), true);
  assert.deepEqual(newCardInput({ design: 'research', name: ' KAUST ', focus: ' Vision group ' }), { kind: 'custom', name: 'KAUST', focus: 'Vision group' });
  assert.deepEqual(newCardInput({ design: 'daily', name: 'Daily tasks', focus: '' }), { kind: 'daily' });
  const html = renderToStaticMarkup(createElement(NewCardDialog, { taken: ['work', 'daily'], busy: false, notice: null, onCancel: () => undefined, onCreate: () => undefined }));
  assert.match(html, /New card/);
  assert.match(html, /aria-label="Research group"/);
  assert.match(html, /aria-checked="true" aria-label="Health"/);
});

test('wallet: card designs follow the kind; custom cards keep their pick, else their name decides', () => {
  assert.equal(profileDesign(work, noMemory), 'work');
  assert.equal(profileDesign(kaust, noMemory), 'research');
  assert.equal(profileDesign(book, noMemory), 'custom');
  assert.equal(designForName('ML Workshop 2026'), 'workshop');
  assert.equal(designForName('Vision lab'), 'research');
  const picked: CgDesignMemory = { read: (id) => (id === 'cgp_book' ? 'workshop' : null), write: () => undefined };
  assert.equal(profileDesign(book, picked), 'workshop');
  const face = profileFace(work, { profileId: 'cgp_work', owner: owner({ build: { status: 'building', errorCode: null } }) }, noMemory);
  assert.equal(face.status, 'building');
  assert.equal(profileFace(book, { profileId: 'cgp_work', owner: owner() }, noMemory).status, 'empty');
  const tile = renderToStaticMarkup(createElement(ProfileCard, { face: { design: 'health', name: 'Health', focus: 'Running', topicCount: 3, status: 'built' } }));
  assert.match(tile, /data-design="health"/);
  assert.match(tile, /3 topics/);
  assert.match(tile, /cg-card-bird/);
  const large = renderToStaticMarkup(createElement(ProfileCard, { size: 'large', face: { design: 'work', name: 'Work', focus: null, topicCount: 2, status: 'built' }, topics: ['Agent memory', 'Retrieval'] }));
  assert.match(large, /is-large/);
  assert.match(large, />Retrieval</);
});

test('wallet: the deck opens the selected tile in place and an empty wallet suggests Work', () => {
  const layout = deckLayout(['a', 'b', 'c'], 'b');
  assert.deepEqual(layout.tiles.map((tile) => [tile.y, tile.height]), [[0, 48], [40, 110], [162, 40]]);
  assert.equal(layout.plusY, 214);
  assert.deepEqual(deckLayout(['a', 'b'], 'b').tiles.map((tile) => tile.height), [48, 110]);
  assert.equal(deckLayout(['a', 'b'], 'b').plusY, 162);
  const empty = new CommonGroundStore(mockServer({}).client, { profiles: true }).getSnapshot();
  assert.deepEqual(deckCards(empty).map((entry) => [entry.id, entry.face.status]), [['suggested', 'suggested']]);
});

test('wallet: the card page shows the header, references and sources', () => {
  const store = new CommonGroundStore(mockServer({}).client, { profiles: true });
  const withRefs = {
    ...card,
    workingOn: ['Agent memory'],
    profile: {
      topics: { 'Agent memory': { refs: ['e1'], firstSeen: '2026-10-03', lastSeen: '2026-10-12' } },
      evidence: { e1: { source: 'Gmail', title: 'Memory draft', date: '2026-10-12', url: null, snippet: 'Started the draft.' } },
    },
  };
  store.set({ profiles: [{ ...work, focus: 'Agent memory research' }], profileId: 'cgp_work', owner: owner({ card: withRefs }) });
  const html = renderToStaticMarkup(createElement(CardScreen, { state: store.getSnapshot(), store }));
  assert.match(html, /Rebuild from memory/);
  assert.match(html, />Rename</);
  assert.match(html, />Delete</);
  assert.match(html, /Agent memory research · 1 line · built/);
  assert.match(html, /Memory draft/);
  assert.match(html, /Gmail · Started the draft\./);
  assert.match(html, /First seen 3 Oct · Last seen 12 Oct/);
  assert.match(html, /aria-label="Hide Agent memory"/);
  assert.match(html, /Share my card/);
});
