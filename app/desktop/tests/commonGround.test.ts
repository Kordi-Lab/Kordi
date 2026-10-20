import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  CommonGroundError,
  commonGroundErrorMessage,
  createCommonGroundClient,
  isRouteMissing,
} from '../src/features/commonGround/client';
import { meetTimes } from '../src/features/commonGround/format';
import { HomeScreen } from '../src/features/commonGround/HomeScreen';
import type { CgHost } from '../src/features/commonGround/host';
import { canMeet, contactActionFor } from '../src/features/commonGround/relationship';
import { CommonGroundStore, LOBBY_POLL_MS, MATCH_POLL_MS } from '../src/features/commonGround/store';
import type { CgOwnerView, CgPerson, CgRelationship } from '../src/features/commonGround/types';

type Call = { url: string; method: string; body: unknown; auth: string | null };
type Reply = { status: number; body?: unknown; headers?: Record<string, string> };

/** A fetch that records calls and answers from a route table, in order per route. */
function mockServer(routes: Record<string, Reply | Reply[]>) {
  const calls: Call[] = [];
  const queues = new Map(Object.entries(routes).map(([key, value]) => [key, Array.isArray(value) ? [...value] : [value]]));
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: headers.get('authorization') });
    const key = `${method} ${url.replace('https://cloud.test/v1/cloud/common-ground/', '')}`;
    const queue = queues.get(key);
    const reply = queue && (queue.length > 1 ? queue.shift()! : queue[0]);
    if (!reply) return new Response('', { status: 404 });
    return new Response(reply.body === undefined ? '' : JSON.stringify(reply.body), { status: reply.status, headers: reply.headers });
  }) as typeof fetch;
  const client = createCommonGroundClient({ baseUrl: () => 'https://cloud.test', fetchImpl: () => fetchImpl, token: async () => 'tok' });
  return { calls, client };
}

const person = (accountId: string, relationship?: CgRelationship): CgPerson => ({ accountId, name: accountId, avatarUrl: null, relationship });
const rel = (patch: Partial<CgRelationship> = {}): CgRelationship => ({ contact: false, request: null, requestId: null, conversationId: null, ...patch });
const card = { workingOn: ['Agent memory'], interests: [], canHelp: [], lookingFor: [], hidden: [], revision: 2, builtAt: '2026-10-20T00:00:00Z' };
const owner = (patch: Partial<CgOwnerView> = {}): CgOwnerView => ({ card, sharing: true, build: { status: 'idle', errorCode: null }, ...patch });

test('client sends bearer JSON requests with the documented bodies', async () => {
  const { calls, client } = mockServer({
    'POST card/build': { status: 202, body: owner({ card: null, build: { status: 'building', errorCode: null } }) },
    'POST rooms/4821/join': { status: 200, body: { code: '4821', members: [] } },
    'PUT card': { status: 200, body: owner() },
  });
  await client.build({ memory: true, connectors: false, device: [{ source: 'Mac Calendar', items: [{ title: 'Talk', date: '2026-10-01' }] }], links: '', notes: 'x' });
  await client.joinRoom('4821', 'Poster session');
  await client.saveTopics({ workingOn: ['A'], interests: [], canHelp: ['B'], lookingFor: [] });
  assert.equal(calls[0].url, 'https://cloud.test/v1/cloud/common-ground/card/build');
  assert.equal(calls[0].auth, 'Bearer tok');
  assert.deepEqual(calls[0].body, { memory: true, connectors: false, device: [{ source: 'Mac Calendar', items: [{ title: 'Talk', date: '2026-10-01' }] }], links: '', notes: 'x' });
  assert.deepEqual(calls[1].body, { name: 'Poster session' });
  assert.deepEqual(calls[2].body, { workingOn: ['A'], interests: [], canHelp: ['B'], lookingFor: [] });
});

test('errors keep the server code, the status and Retry-After', async () => {
  const { client } = mockServer({
    'POST card/build': { status: 429, body: { errorCode: 'rate_limited', message: 'Try again in a minute.' }, headers: { 'Retry-After': '600' } },
    'GET rooms/0000': { status: 404, body: { errorCode: 'common_ground_room_not_found', message: 'Room not found.' } },
  });
  const limited = await client.build({ memory: false, connectors: false, device: [], links: '', notes: 'x' }).catch((error: unknown) => error);
  assert.ok(limited instanceof CommonGroundError);
  assert.equal(limited.code, 'rate_limited');
  assert.equal(limited.retryAfterSeconds, 600);
  assert.equal(commonGroundErrorMessage(limited), 'Try again in 10 min.');
  const missingRoom = await client.room('0000').catch((error: unknown) => error);
  assert.equal(isRouteMissing(missingRoom), false);
  assert.equal(commonGroundErrorMessage(missingRoom), 'Room not found.');
  const oldServer = await client.chat('acct_b').catch((error: unknown) => error);
  assert.equal(isRouteMissing(oldServer), true);
});

test('a 202 match is pending and a 200 match is ready', async () => {
  const { client } = mockServer({
    'GET people/acct_b/match': [
      { status: 202, body: { status: 'matching', person: person('acct_b') } },
      { status: 200, body: { score: 72, headline: 'Agent memory', shared: [], youBring: [], theyBring: [], nextStep: '', status: 'ready', person: person('acct_b') } },
    ],
  });
  assert.equal((await client.match('acct_b')).status, 'matching');
  const ready = await client.match('acct_b');
  assert.equal(ready.status, 'ready');
  assert.equal(ready.score, 72);
});

test('store: a build finishes on the card and polling stops', async () => {
  const { client } = mockServer({
    'GET card': [{ status: 200, body: owner({ card: null }) }, { status: 200, body: owner({ card: null, build: { status: 'building', errorCode: null } }) }, { status: 200, body: owner() }],
    'POST card/build': { status: 202, body: owner({ card: null, build: { status: 'building', errorCode: null } }) },
  });
  const store = new CommonGroundStore(client);
  await store.loadHome();
  assert.equal(store.getSnapshot().owner?.card, null);
  store.open({ name: 'build' });
  await store.build({ memory: false, connectors: false, device: [], links: '', notes: 'x' });
  assert.equal(store.getSnapshot().owner?.build.status, 'building');
  assert.equal(await store.poll(), 3_000);
  assert.equal(await store.poll(), null);
  assert.deepEqual(store.getSnapshot().owner?.card?.workingOn, ['Agent memory']);
  assert.deepEqual(store.getSnapshot().stack, [{ name: 'home' }]);
});

test('store: join, lobby polling, results polling until ready', async () => {
  const room = { roomId: 'r', code: '4821', name: '', openedByYou: true, expiresAt: '', members: [person('a'), person('b')] };
  const { calls, client } = mockServer({
    'POST rooms/4821/join': { status: 200, body: room },
    'GET rooms/4821': { status: 200, body: room },
    'POST rooms/4821/results': [
      { status: 200, body: { status: 'matching', people: [], topics: [], suggestion: null } },
      { status: 200, body: { status: 'ready', people: [{ person: person('a'), score: 80, headline: 'x' }], topics: [], suggestion: null } },
    ],
  });
  const store = new CommonGroundStore(client);
  assert.equal(await store.joinRoom('4821'), true);
  assert.deepEqual(store.top(), { name: 'lobby', code: '4821' });
  assert.equal(await store.poll(), LOBBY_POLL_MS);
  await store.findCommonGround('4821');
  assert.deepEqual(store.top(), { name: 'results', code: '4821' });
  assert.equal(store.getSnapshot().stack.length, 2);
  assert.equal(await store.poll(), null);
  assert.equal(store.getSnapshot().results['4821'].status, 'ready');
  assert.equal(await store.poll(), null);
  assert.equal(calls.filter((call) => call.url.endsWith('/results')).length, 2);
});

test('store: joining without a card opens the build screen', async () => {
  const { client } = mockServer({ 'POST rooms/4821/join': { status: 409, body: { errorCode: 'common_ground_no_card', message: 'Build your card first.' } } });
  const store = new CommonGroundStore(client);
  assert.equal(await store.joinRoom('4821'), false);
  assert.deepEqual(store.top(), { name: 'build' });
});

test('store: match 202 polls until 200', async () => {
  const { client } = mockServer({
    'GET people/acct_b/match': [
      { status: 202, body: { status: 'matching', person: person('acct_b') } },
      { status: 200, body: { score: 40, headline: 'h', shared: [], youBring: [], theyBring: [], nextStep: '', status: 'ready', person: person('acct_b', rel()) } },
    ],
  });
  const store = new CommonGroundStore(client);
  store.open({ name: 'match', accountId: 'acct_b' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(store.getSnapshot().matches.acct_b.status, 'matching');
  assert.equal(await store.poll(), null);
  assert.equal(store.getSnapshot().matches.acct_b.score, 40);
  assert.deepEqual(store.relationshipFor('acct_b'), rel());
});

test('client keeps the relationship sent beside the person', async () => {
  const contact = rel({ contact: true, conversationId: 'dm_b' });
  const { client } = mockServer({
    'GET people/acct_b/match': [
      { status: 202, body: { status: 'matching', person: person('acct_b'), relationship: contact } },
      { status: 200, body: { score: 72, headline: 'x', shared: [], status: 'ready', person: person('acct_b'), relationship: contact } },
    ],
    'GET people/acct_b': { status: 200, body: { person: person('acct_b'), relationship: contact, card } },
    'POST rooms/4821/results': { status: 200, body: { status: 'ready', people: [{ person: person('acct_b'), score: 80, headline: 'x', relationship: contact }], topics: [], suggestion: null } },
    'GET recent': { status: 200, body: { people: [{ person: person('acct_b'), score: 80, headline: 'x', relationship: contact }] } },
  });
  assert.deepEqual((await client.match('acct_b')).person.relationship, contact);
  assert.deepEqual((await client.match('acct_b')).person.relationship, contact);
  assert.deepEqual((await client.person('acct_b')).person.relationship, contact);
  assert.deepEqual((await client.results('4821')).people[0].person.relationship, contact);
  assert.deepEqual((await client.recent()).people[0].person.relationship, contact);
});

test('store: a match with a relationship shows the actions', async () => {
  const { client } = mockServer({
    'GET people/acct_b/match': { status: 200, body: { score: 72, headline: 'x', shared: [], status: 'ready', person: person('acct_b'), relationship: rel({ contact: true, conversationId: 'dm_b' }) } },
  });
  const store = new CommonGroundStore(client);
  await store.loadScreen({ name: 'match', accountId: 'acct_b' });
  const { support } = store.getSnapshot();
  assert.equal(support.contact && support.chat && support.meet, true);
  assert.equal(contactActionFor(store.relationshipFor('acct_b'), support.contact), 'message');
  assert.equal(canMeet(store.relationshipFor('acct_b')), true);
});

test('home shows pair digits and no text pair code', async () => {
  const { client } = mockServer({ 'GET card': { status: 200, body: owner() }, 'GET recent': { status: 200, body: { people: [] } } });
  const store = new CommonGroundStore(client);
  await store.loadHome();
  const host = { self: { accountId: 'me', name: 'Me', avatarUrl: null } } as unknown as CgHost;
  const html = renderToStaticMarkup(createElement(HomeScreen, { state: store.getSnapshot(), store, host }));
  assert.match(html, /Pair code/);
  assert.match(html, />Join</);
  assert.doesNotMatch(html, /Their code|New code|Room code/);
  assert.equal('pairCode' in store.getSnapshot(), false);
});

test('store: missing action routes hide the action', async () => {
  const { client } = mockServer({});
  const store = new CommonGroundStore(client);
  await store.addContact('acct_b');
  assert.equal(store.getSnapshot().support.contact, false);
  assert.equal(contactActionFor(rel(), store.getSnapshot().support.contact), 'hidden');
  assert.equal(await store.chat('acct_b'), true);
  assert.equal(store.getSnapshot().support.chat, false);
  assert.equal(store.getSnapshot().notice, null);
});

test('store: chat between non-contacts keeps the returned relationship', async () => {
  const { client } = mockServer({
    'POST people/acct_b/chat': { status: 409, body: { errorCode: 'common_ground_not_contacts', message: 'Add each other first.', relationship: rel({ request: 'outgoing' }) } },
  });
  const store = new CommonGroundStore(client);
  assert.equal(await store.chat('acct_b'), false);
  assert.equal(contactActionFor(store.relationshipFor('acct_b'), true), 'requested');
});

test('relationship maps to the contact action and Meet', () => {
  assert.equal(contactActionFor(undefined, true), 'hidden');
  assert.equal(contactActionFor(rel(), true), 'add');
  assert.equal(contactActionFor(rel({ request: 'outgoing', requestId: 'r1' }), true), 'requested');
  assert.equal(contactActionFor(rel({ request: 'incoming', requestId: 'r2' }), true), 'accept');
  assert.equal(contactActionFor(rel({ contact: true, conversationId: 'c' }), false), 'message');
  assert.equal(canMeet(rel()), false);
  assert.equal(canMeet(rel({ contact: true })), true);
});

test('meet times turn a local slot into ISO start and end', () => {
  const times = meetTimes('2026-10-21', '14:00', 90);
  assert.ok(times);
  assert.equal(Date.parse(times.endAt) - Date.parse(times.startAt), 90 * 60_000);
  assert.equal(meetTimes('', '', 30), null);
});

test('rate limits without Retry-After ask for a minute', () => {
  assert.equal(commonGroundErrorMessage(new CommonGroundError('x', 429, 'rate_limited')), 'Try again in 1 min.');
  assert.equal(MATCH_POLL_MS, 3_000);
});
