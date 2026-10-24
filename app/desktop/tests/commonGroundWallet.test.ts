import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  CARD_DESIGNS, canCreateCard, designForName, firstFreeDesign, newCardDraft, newCardInput, profileDesign,
} from '../src/features/commonGround/cardDesign';
import { CardLookPopover } from '../src/features/commonGround/CardLookPopover';
import { CardGlyph } from '../src/features/commonGround/ProfileCard';
import { CG_CARD_DESIGNS } from '../src/features/commonGround/types';
import { CardScreen, RenameFields } from '../src/features/commonGround/CardScreen';
import { PairCodePanel } from '../src/features/commonGround/PairCodePanel';
import { NewCardDialog } from '../src/features/commonGround/NewCardDialog';
import { ProfileCard } from '../src/features/commonGround/ProfileCard';
import { renameError, renamePatch, takenKinds } from '../src/features/commonGround/profiles';
import { CommonGroundStore, SYNC_INTERVAL_MS } from '../src/features/commonGround/store';
import { LOOK_NOT_SAVED } from '../src/features/commonGround/storeProfiles';
import { syncOnVisible } from '../src/features/commonGround/syncOnVisible';
import { deckCards, deckLayout, latestOnly, ownerIsCurrent, profileFace, suggestedProfile } from '../src/features/commonGround/wallet';

import { card, mockServer, owner, profile, room, SERVER_DESIGNS } from './helpers/commonGroundServer';

const work = profile('cgp_work', 'work', 'Work', true);
const health = profile('cgp_health', 'health', 'Health', true);
const kaust = profile('cgp_kaust', 'custom', 'KAUST', true);
const book = profile('cgp_book', 'custom', 'Book club', false);

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

test('wallet: a code for a room you are already in opens it from the preview', async () => {
  const { calls, client } = mockServer({
    'GET rooms/2468/preview': { status: 200, body: { code: '2468', name: 'Lab lunch', kind: 'work', memberCount: 4, member: true } },
    'GET rooms': { status: 200, body: { rooms: [{ code: '2468', name: 'Lab lunch', open: true }] } },
  });
  const store = new CommonGroundStore(client, { profiles: true });
  assert.deepEqual(await store.lookUpCode('2468'), { status: 'joined', code: '2468' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(calls.some((call) => call.url.endsWith('/common-ground/rooms')));
  assert.equal(store.getSnapshot().roomList[0]?.code, '2468');
});

test('wallet: a code suggests a built card of the room kind', () => {
  const workshops = profile('cgp_ws', 'custom', 'Workshops', true);
  assert.equal(suggestedProfile([work, workshops], 'custom', 'cgp_work')?.profileId, 'cgp_ws');
  assert.equal(suggestedProfile([work, workshops], 'work', 'cgp_work'), null);
  assert.equal(suggestedProfile([work, { ...health, hasCard: false }], 'health', 'cgp_work'), null);
  assert.equal(suggestedProfile([work], null, 'cgp_work'), null);
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
  assert.deepEqual(newCardInput({ design: 'research', name: ' KAUST ', focus: ' Vision group ' }), { kind: 'custom', name: 'KAUST', focus: 'Vision group', design: 'research' });
  assert.deepEqual(newCardInput({ design: 'daily', name: 'Daily', focus: '' }), { kind: 'daily' });
  // The look picked on the card's icon square goes with the create request.
  assert.deepEqual(newCardInput({ design: 'work', name: '', focus: '', background: 'research', icon: 'rocket' }), { kind: 'work', design: 'research', icon: 'rocket' });
  assert.deepEqual(newCardInput({ design: 'work', name: '', focus: '', background: 'work', icon: null }), { kind: 'work' });
  assert.equal(newCardDraft('health', { design: 'work', name: '', focus: '', background: 'daily', icon: 'sun' }).icon, undefined);
  const html = renderToStaticMarkup(createElement(NewCardDialog, { taken: ['work', 'daily'], busy: false, notice: null, onCancel: () => undefined, onCreate: () => undefined }));
  assert.match(html, /New card/);
  assert.match(html, /aria-label="Research group"/);
  assert.match(html, /aria-checked="true" aria-label="Health"/);
  assert.match(html, /placeholder="Focus, optional"/);
  assert.match(html, /aria-label="Background and icon"/);
});

test('wallet: the server design wins, then the kind, and a custom card without one goes by its name', () => {
  assert.equal(profileDesign(work), 'work');
  assert.equal(profileDesign(kaust), 'research');
  assert.equal(profileDesign(book), 'custom');
  assert.equal(designForName('ML Workshop 2026'), 'workshop');
  assert.equal(designForName('Vision lab'), 'research');
  assert.equal(profileDesign({ ...book, design: 'workshop' }), 'workshop');
  assert.equal(profileDesign({ ...kaust, design: 'custom' }), 'custom');
  assert.equal(profileDesign({ ...work, design: 'health' }), 'health');
  assert.equal(profileDesign({ kind: 'custom', name: 'MIT' }), 'research');
  const face = profileFace(work, { profileId: 'cgp_work', owner: owner({ build: { status: 'building', errorCode: null } }) });
  assert.equal(face.status, 'building');
  assert.equal(profileFace(book, { profileId: 'cgp_work', owner: owner() }).status, 'empty');
  assert.equal(profileFace({ ...book, icon: 'coffee' }, { profileId: 'cgp_work', owner: owner() }).icon, 'coffee');
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
  assert.match(html, /class="cg-cardpage-focus">Agent memory research</);
  assert.match(html, /class="cg-cardpage-meta">1 line · built/);
  assert.match(html, /aria-label="Background and icon"/);
  assert.match(html, /Memory draft/);
  assert.match(html, /<q class="cg-ref-quote">Started the draft\.<\/q>/);
  assert.match(html, /Memory draft<\/span><span aria-hidden="true">·<\/span><span>Gmail · 12 Oct<\/span>/);
  assert.match(html, /First seen 3 Oct · Last seen 12 Oct/);
  assert.match(html, /aria-label="Hide Agent memory"/);
  assert.match(html, /Share my card/);
});

test('wallet: profiles read design and icon from the server and send them on create', async () => {
  const { calls, client } = mockServer({
    'GET profiles': { status: 200, body: { profiles: [
      { ...book, design: 'workshop', icon: 'rocket' },
      { ...work, design: undefined, icon: undefined },
      { ...health, design: 'neon', icon: 'unicorn' },
    ] } },
    'POST profiles': { status: 201, body: { ...kaust, design: 'research', icon: 'flask' } },
  });
  const profiles = await client.profiles();
  assert.deepEqual(profiles.map((item) => [item.design, item.icon]), [['workshop', 'rocket'], [null, null], [null, null]]);
  const created = await client.createProfile({ kind: 'custom', name: 'KAUST', design: 'research', icon: 'flask' });
  assert.deepEqual([created.design, created.icon], ['research', 'flask']);
  assert.deepEqual(calls[1].body, { kind: 'custom', name: 'KAUST', design: 'research', icon: 'flask' });
  assert.deepEqual((await client.createProfile({ kind: 'work' })).profileId, 'cgp_kaust');
  assert.deepEqual(calls[2].body, { kind: 'work' });
});

test('wallet: the look popover applies at once, saves, and puts the old look back when saving fails', async () => {
  const { calls, client } = mockServer({
    'PUT profiles/cgp_book': [
      { status: 200, body: { ...book, design: 'research', icon: null } },
      { status: 200, body: { ...book, design: 'research', icon: 'coffee' } },
      { status: 500, body: { message: 'Could not save.' } },
      { status: 200, body: { ...book, design: 'research', icon: null } },
      { status: 200, body: { ...book, design: undefined, icon: null } },
    ],
  });
  const store = new CommonGroundStore(client, { profiles: true });
  store.set({ profiles: [work, book], profileId: 'cgp_book' });
  const saving = store.setLook('cgp_book', { design: 'research' });
  assert.equal(store.getSnapshot().profiles[1].design, 'research');
  assert.equal(await saving, true);
  assert.deepEqual(calls[0].body, { design: 'research' });
  assert.equal(await store.setLook('cgp_book', { icon: 'coffee' }), true);
  assert.deepEqual(calls[1].body, { icon: 'coffee' });
  assert.equal(store.getSnapshot().profiles[1].icon, 'coffee');
  const failing = store.setLook('cgp_book', { design: 'daily' });
  assert.equal(store.getSnapshot().profiles[1].design, 'daily');
  assert.equal(await failing, false);
  assert.deepEqual([store.getSnapshot().profiles[1].design, store.getSnapshot().profiles[1].icon], ['research', 'coffee']);
  assert.equal(store.getSnapshot().notice, 'Could not save.');
  // The current icon again resets it to the design's own glyph.
  assert.equal(await store.setLook('cgp_book', { icon: null }), true);
  assert.deepEqual(calls[3].body, { icon: null });
  assert.equal(store.getSnapshot().profiles[1].icon, null);
  // A reply without the new value did not save it: the server's look stays, with a notice.
  assert.equal(await store.setLook('cgp_book', { design: 'ocean' }), false);
  assert.equal(store.getSnapshot().profiles[1].design, null);
  assert.equal(store.getSnapshot().notice, LOOK_NOT_SAVED);
  const picks: unknown[] = [];
  const html = renderToStaticMarkup(createElement(CardLookPopover, {
    design: 'research', icon: 'coffee', onClose: () => undefined, onDesign: (design) => picks.push(design), onIcon: (icon) => picks.push(icon),
  }));
  assert.match(html, />Background</);
  assert.match(html, />Icon</);
  assert.equal(html.match(/role="radio"/g)?.length, 34);
  assert.match(html, /aria-label="Ocean" title="Ocean" data-design="ocean" class="cg-look-colour"/);
  // Background is one grid of sixteen plain swatches, kind designs first; only the icon grid draws glyphs.
  const background = html.slice(html.indexOf('aria-label="Background"'), html.indexOf('>Icon<'));
  assert.equal(background.match(/class="cg-look-colour/g)?.length, 16);
  assert.doesNotMatch(background, /<svg/);
  assert.deepEqual([...background.matchAll(/data-design="(\w+)"/g)].map((match) => match[1]).slice(0, 7), ['work', 'health', 'daily', 'workshop', 'research', 'custom', 'ocean']);
  assert.match(background, /aria-checked="true" aria-label="Research group" title="Research group" data-design="research" class="cg-look-colour is-on"/);
  assert.match(html, /aria-checked="true" aria-label="Research group"/);
  assert.match(html, /aria-checked="true" aria-label="Coffee"/);
  assert.equal(html.match(/aria-checked="true"/g)?.length, 2);
});

test('wallet: a colour or icon changed on another device shows up when Grounding is visible again, at most every 30 seconds', async () => {
  const { calls, client } = mockServer({
    'GET profiles': [
      { status: 200, body: { profiles: [work, book] } },
      { status: 200, body: { profiles: [work, { ...book, design: 'ocean', icon: 'rocket', name: 'Books' }] } },
    ],
    'GET card?profile=cgp_work': [
      { status: 200, body: owner() },
      { status: 200, body: owner({ card: { ...card, workingOn: ['Agent memory', 'Retrieval'] } }) },
    ],
  });
  const store = new CommonGroundStore(client, { profiles: true });
  store.set({ profileId: 'cgp_work' });
  await store.loadHome();
  const win = new EventTarget();
  const doc = Object.assign(new EventTarget(), { hidden: false });
  let now = Date.now() + SYNC_INTERVAL_MS;
  const syncs: Array<Promise<boolean>> = [];
  const stop = syncOnVisible(() => { syncs.push(store.syncFromServer(now)); }, win, doc);
  win.dispatchEvent(new Event('focus'));
  assert.equal(await syncs[0], true);
  const synced = store.getSnapshot().profiles.find((item) => item.profileId === 'cgp_book');
  assert.deepEqual([synced?.design, synced?.icon, synced?.name], ['ocean', 'rocket', 'Books']);
  assert.deepEqual(store.getSnapshot().owner?.card?.workingOn, ['Agent memory', 'Retrieval']);
  // Within 30 seconds another focus or visibility change does not fetch again.
  const fetched = calls.length;
  now += SYNC_INTERVAL_MS - 1;
  doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(await syncs[1], false);
  assert.equal(calls.length, fetched);
  // A hidden document does not sync; a visible one does once the gap has passed.
  now += 1;
  doc.hidden = true;
  doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(syncs.length, 2);
  doc.hidden = false;
  doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(await syncs[2], true);
  assert.ok(calls.length > fetched);
  stop();
  win.dispatchEvent(new Event('focus'));
  assert.equal(syncs.length, 3);
  // A save in flight is never overwritten.
  store.set({ busy: 'look' });
  assert.equal(await store.syncFromServer(now + SYNC_INTERVAL_MS), false);
});

test('wallet: Home asks for the expected card while the profile list loads', async () => {
  const { calls, client } = mockServer({
    'GET profiles': { status: 200, body: { profiles: [work, health] } },
    'GET card?profile=cgp_health': { status: 200, body: owner() },
    'GET card?profile=cgp_work': { status: 200, body: owner() },
  });
  const store = new CommonGroundStore(client, { profiles: true, memory: { read: () => 'cgp_health', write: () => undefined } });
  await store.loadHome();
  assert.deepEqual(calls.slice(0, 2).map((call) => call.url.split('/').pop()), ['card?profile=cgp_health', 'profiles']);
  assert.equal(calls.filter((call) => call.url.includes('/card')).length, 1);
  // A saved card that is gone loads the one picked instead.
  const gone = mockServer({
    'GET profiles': { status: 200, body: { profiles: [work] } },
    'GET card?profile=cgp_gone': { status: 404, body: { errorCode: 'common_ground_profile_not_found', message: 'Gone.' } },
    'GET card?profile=cgp_work': { status: 200, body: owner() },
  });
  const picked = new CommonGroundStore(gone.client, { profiles: true, memory: { read: () => 'cgp_gone', write: () => undefined } });
  await picked.loadHome();
  assert.equal(picked.getSnapshot().profileId, 'cgp_work');
  assert.equal(picked.getSnapshot().notice, null);
  assert.ok(picked.getSnapshot().owner?.card);
});

test('wallet: pair code lookups keep only the newest, and the preview names the suggested card', async () => {
  const requests = latestOnly();
  const first = requests.next();
  const second = requests.next();
  assert.equal(first(), false);
  assert.equal(second(), true);
  requests.cancel();
  assert.equal(second(), false);
  const { client } = mockServer({
    'GET rooms/4821/preview': { status: 200, body: { code: '4821', name: 'Poster session', kind: 'custom', memberCount: 3, suggestedProfileId: 'cgp_book' } },
    'GET rooms/2468/preview': { status: 200, body: { code: '2468', name: 'Lab', kind: 'work', memberCount: 4, member: true, profileId: 'cgp_work' } },
  });
  assert.deepEqual(await client.previewRoom('4821'), { code: '4821', name: 'Poster session', kind: 'custom', memberCount: 3, suggestedProfileId: 'cgp_book' });
  assert.equal((await client.previewRoom('2468')).profileId, 'cgp_work');
  // The server's pick wins over the kind; a pick that is the current card or not built suggests nothing.
  assert.equal(suggestedProfile([work, kaust, health], 'custom', 'cgp_work', 'cgp_health')?.profileId, 'cgp_health');
  assert.equal(suggestedProfile([work, kaust], 'custom', 'cgp_work', 'cgp_work'), null);
  assert.equal(suggestedProfile([work, book], 'custom', 'cgp_work', 'cgp_book'), null);
});

test('wallet: joining with the suggested card sends its profile and keeps the selected card', async () => {
  const { calls, client } = mockServer({ 'POST rooms/4821/join': { status: 200, body: room('4821') } });
  const store = new CommonGroundStore(client, { profiles: true });
  store.set({ profiles: [work, kaust], profileId: 'cgp_work' });
  assert.equal(await store.joinRoom('4821', { profileId: 'cgp_kaust', kind: 'custom' }), true);
  assert.deepEqual(calls[0].body, { profileId: 'cgp_kaust', kind: 'custom' });
  assert.equal(store.getSnapshot().profileId, 'cgp_work');
  assert.deepEqual(store.top(), { name: 'lobby', code: '4821' });
});

test('wallet: Create needs any built card, not only the selected one', () => {
  const store = new CommonGroundStore(mockServer({}).client, { profiles: true });
  const create = (html: string) => /<button[^>]*data-cg-create="true"[^>]*>/.exec(html)?.[0] ?? '';
  store.set({ profiles: [book, work], profileId: 'cgp_book', owner: owner({ card: null }), loaded: true });
  assert.doesNotMatch(create(renderToStaticMarkup(createElement(PairCodePanel, { state: store.getSnapshot(), store }))), /disabled/);
  store.set({ profiles: [book], profileId: 'cgp_book' });
  assert.match(create(renderToStaticMarkup(createElement(PairCodePanel, { state: store.getSnapshot(), store }))), /disabled/);
});

test('wallet: renaming sends an emptied name so the kind default comes back, and a custom card needs one', () => {
  assert.deepEqual(renamePatch(work, '', ''), { name: '' });
  assert.deepEqual(renamePatch(work, 'Work', 'Agents'), { focus: 'Agents' });
  assert.deepEqual(renamePatch(work, 'Work', ''), {});
  assert.equal(renameError('work', ''), null);
  assert.equal(renameError('custom', '  '), 'A custom card needs a name.');
  assert.equal(renameError('custom', 'Lab'), null);
});

test('wallet: the card page waits for a newly selected card instead of showing old topics', () => {
  const store = new CommonGroundStore(mockServer({}).client, { profiles: true });
  const workOwner = owner({ profile: { profileId: 'cgp_work', kind: 'work', name: 'Work', focus: null } });
  store.set({ profiles: [work, health], profileId: 'cgp_health', owner: workOwner, stack: [{ name: 'home' }, { name: 'card' }] });
  assert.equal(ownerIsCurrent(store.getSnapshot()), false);
  const waiting = renderToStaticMarkup(createElement(CardScreen, { state: store.getSnapshot(), store }));
  assert.match(waiting, /Opening card/);
  assert.doesNotMatch(waiting, /Agent memory/);
  store.set({ profileId: 'cgp_work' });
  assert.equal(ownerIsCurrent(store.getSnapshot()), true);
  assert.match(renderToStaticMarkup(createElement(CardScreen, { state: store.getSnapshot(), store })), /Agent memory/);
});

test('wallet: the rename fields say the focus is optional', () => {
  const store = new CommonGroundStore(mockServer({}).client, { profiles: true });
  store.set({ profiles: [work], profileId: 'cgp_work', owner: owner() });
  const html = renderToStaticMarkup(createElement(CardScreen, { state: store.getSnapshot(), store }));
  assert.doesNotMatch(html, /cg-cardpage-focus/);
  const fields = renderToStaticMarkup(createElement(RenameFields, { name: 'Work', focus: '', kind: 'work', onSave: () => undefined, onCancel: () => undefined }));
  assert.match(fields, /placeholder="Focus, optional" aria-label="Focus"/);
});

test('wallet: all sixteen backgrounds round-trip, and a colour keeps its kind glyph', async () => {
  assert.deepEqual([...CG_CARD_DESIGNS], [...SERVER_DESIGNS]);
  const { calls, client } = mockServer({
    'GET profiles': { status: 200, body: { profiles: SERVER_DESIGNS.map((design, index) => ({ ...book, profileId: `cgp_${index}`, design })) } },
    ...Object.fromEntries(SERVER_DESIGNS.map((design) => [`PUT profiles/cgp_${design}`, { status: 200, body: { ...book, profileId: `cgp_${design}`, design } }])),
  });
  assert.deepEqual((await client.profiles()).map((item) => item.design), [...SERVER_DESIGNS]);
  for (const design of SERVER_DESIGNS) {
    const updated = await client.updateProfile(`cgp_${design}`, { design });
    assert.equal(updated.design, design);
    assert.equal(profileDesign(updated), design);
    assert.deepEqual(calls[calls.length - 1].body, { design });
  }
  const glyph = (kind: 'health' | 'custom') => renderToStaticMarkup(createElement(CardGlyph, { design: 'ocean', kind }));
  assert.equal(glyph('health'), renderToStaticMarkup(createElement(CardGlyph, { design: 'health' })));
  assert.equal(glyph('custom'), renderToStaticMarkup(createElement(CardGlyph, { design: 'custom' })));
});
