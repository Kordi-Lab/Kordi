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
import { agentFilesSummary, canBuildProfile, commonGroundBuildRequest, type CgBuildChoices } from '../src/features/commonGround/buildRequest';
import { meetRequest, meetTimes, meetTimeSlots, shiftMeetDate, topicGroupDraft } from '../src/features/commonGround/format';
import { groupLine, meetTimes, topicGroupDraft } from '../src/features/commonGround/format';
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

test('meet request ends at start plus the chosen duration', () => {
  const draft = { name: 'Hana', title: '  ', date: '2026-10-21', time: '14:15', minutes: 90, location: '' };
  const request = meetRequest(draft);
  assert.ok(request);
  assert.equal(request.title, 'Meet Hana');
  assert.equal(request.startAt, new Date('2026-10-21T14:15').toISOString());
  assert.equal(Date.parse(request.endAt) - Date.parse(request.startAt), 90 * 60_000);
  assert.equal('location' in request, false);
  const placed = meetRequest({ ...draft, title: 'Coffee', minutes: 120, location: ' Cafe ' });
  assert.deepEqual(placed && { title: placed.title, location: placed.location, span: Date.parse(placed.endAt) - Date.parse(placed.startAt) }, { title: 'Coffee', location: 'Cafe', span: 120 * 60_000 });
  assert.equal(meetRequest({ ...draft, date: '' }), null);
});

test('meet pickers step days across months and times in 15 minutes', () => {
  assert.equal(shiftMeetDate('2026-10-31', 1), '2026-11-01');
  assert.equal(shiftMeetDate('2026-01-01', -1), '2025-12-31');
  const slots = meetTimeSlots();
  assert.equal(slots.length, 96);
  assert.deepEqual([slots[0], slots[1], slots[95]], ['00:00', '00:15', '23:45']);
});

test('rate limits without Retry-After ask for a minute', () => {
  assert.equal(commonGroundErrorMessage(new CommonGroundError('x', 429, 'rate_limited')), 'Try again in 1 min.');
  assert.equal(MATCH_POLL_MS, 3_000);
});

test('build request sends agents only with the switch on and connectors when one is connected', () => {
  const files = [{ label: '.claude/CLAUDE.md', text: 'a' }, { label: 'AGENTS.md', text: 'b' }];
  const base: CgBuildChoices = { memory: false, connectedCount: 0, useAgents: false, agentFiles: files, device: [], links: '', notes: '' };
  assert.deepEqual(commonGroundBuildRequest(base), { memory: false, connectors: false, device: [], links: '', notes: '' });
  assert.equal(canBuildProfile(base), false);
  const withAgents = commonGroundBuildRequest({ ...base, useAgents: true });
  assert.deepEqual(withAgents.agents, files);
  assert.equal(withAgents.connectors, false);
  assert.equal('agents' in commonGroundBuildRequest({ ...base, useAgents: true, agentFiles: [] }), false);
  const withConnector = commonGroundBuildRequest({ ...base, connectedCount: 1 });
  assert.equal(withConnector.connectors, true);
  assert.equal('agents' in withConnector, false);
  assert.equal(canBuildProfile({ ...base, connectedCount: 1 }), true);
  assert.equal(canBuildProfile({ ...base, useAgents: true }), true);
  assert.equal(canBuildProfile({ ...base, notes: ' x ' }), true);
});

test('client sends the agent files in the build body', async () => {
  const { calls, client } = mockServer({ 'POST card/build': { status: 202, body: owner({ card: null, build: { status: 'building', errorCode: null } }) } });
  const agents = [{ label: 'AGENTS.md', text: 'Be brief.' }];
  await client.build(commonGroundBuildRequest({ memory: false, connectedCount: 2, useAgents: true, agentFiles: agents, device: [], links: '', notes: '' }));
  assert.deepEqual(calls[0].body, { memory: false, connectors: true, device: [], links: '', notes: '', agents });
});

test('agent files summary names two files and counts the rest', () => {
  const file = (label: string) => ({ label, text: '' });
  assert.equal(agentFilesSummary([]), 'No agent files found');
  assert.equal(agentFilesSummary([file('AGENTS.md'), file('.claude/CLAUDE.md'), file('a/b.md'), file('c.md'), file('d.md')]), 'AGENTS.md, CLAUDE.md +3');
  assert.equal(agentFilesSummary([file('.codex/AGENTS.md')]), 'AGENTS.md');
});

test('rooms list decodes with and without open, and a 404 without a code hides it', async () => {
  const { client } = mockServer({
    'GET rooms': { status: 200, body: { rooms: [
      { code: '4821', name: 'Poster session', open: true, memberCount: 5, joinedAt: 'a', lastActivityAt: 'b', themeCount: 3 },
      { code: '1907', name: '', open: false, memberCount: 3, joinedAt: 'a', lastActivityAt: 'b', themeCount: 2 },
      { code: '5550', name: 'Old', memberCount: 2, joinedAt: 'a', lastActivityAt: 'b', themeCount: 1 },
    ] } },
  });
  const rooms = await client.rooms();
  assert.deepEqual(rooms.map((room) => room.open), [true, false, true]);
  assert.equal(rooms[1].themeCount, 2);
  const old = new CommonGroundStore(mockServer({}).client);
  await old.loadRooms();
  assert.equal(old.getSnapshot().support.rooms, false);
  assert.deepEqual(old.getSnapshot().roomList, []);
});

test('store: a closed room opens read-only results without polling', async () => {
  const room = { roomId: 'r', code: '1907', name: '', openedByYou: false, expiresAt: '', members: [person('a')], open: false };
  const { calls, client } = mockServer({
    'GET rooms': { status: 200, body: { rooms: [{ code: '1907', name: '', open: false, memberCount: 2, joinedAt: '', lastActivityAt: '', themeCount: 1 }] } },
    'GET rooms/1907': { status: 200, body: room },
    'POST rooms/1907/results': { status: 200, body: { status: 'matching', people: [], topics: [], suggestion: null } },
    'POST rooms/1907/leave': { status: 204 },
  });
  const store = new CommonGroundStore(client);
  await store.loadRooms();
  store.openRoom('1907');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(store.top(), { name: 'results', code: '1907' });
  assert.equal(await store.poll(), null);
  assert.equal(calls.filter((call) => call.url.endsWith('/results')).length, 1);
  await store.leaveRoom('1907');
  assert.deepEqual(store.top(), { name: 'home' });
  assert.ok(calls.some((call) => call.method === 'POST' && call.url.endsWith('/rooms/1907/leave')));
});

test('a topic group request carries the topic and the group keeps it', async () => {
  const { calls, client } = mockServer({
    'POST rooms/4821/results': { status: 200, body: { status: 'ready', people: [], topics: [], suggestion: null, groups: [{ groupSpaceId: 'g0', conversationId: 'c0', name: 'Old', memberCount: 2 }] } },
    'POST rooms/4821/group': { status: 200, body: { group: { groupSpaceId: 'g1', conversationId: 'c1', name: 'Retrieval', memberCount: 2 }, added: [], invited: [] } },
  });
  const store = new CommonGroundStore(client);
  await store.findCommonGround('4821');
  assert.equal(store.getSnapshot().results['4821'].groups?.[0].topic, null);
  const created = await store.createGroup('4821', 'Retrieval', ['b'], 'Retrieval');
  assert.equal(created?.group.groupSpaceId, 'g1');
  assert.deepEqual(calls.at(-1)?.body, { name: 'Retrieval', memberIds: ['b'], topic: 'Retrieval' });
  assert.equal(store.getSnapshot().results['4821'].groups?.at(-1)?.topic, 'Retrieval');
});

test('Start from a topic row names the group after the topic and selects its people', () => {
  const draft = topicGroupDraft({ label: 'Agent memory', people: [person('me'), person('hana'), person('maya')] }, 'me');
  assert.deepEqual(draft, { name: 'Agent memory', topic: 'Agent memory', selected: ['hana', 'maya'] });
});

test('group rows: member line grammar and missing members fall back to empty', async () => {
  assert.equal(groupLine({ topic: 'Eval design', memberCount: 3 }), 'From Eval design · 3 members');
  assert.equal(groupLine({ topic: null, memberCount: 1 }), '1 member');
  assert.equal(groupLine({ topic: null, memberCount: 2 }), '2 members');
  assert.equal(groupLine({ topic: 'Eval design', memberCount: 0 }), 'From Eval design');
  const { client } = mockServer({
    'POST rooms/4821/results': { status: 200, body: { status: 'ready', people: [], topics: [], suggestion: null, groups: [
      { groupSpaceId: 'g1', conversationId: 'group:g1', name: 'Old', memberCount: 2 },
      { groupSpaceId: 'g2', conversationId: 'group:g2', name: 'New', memberCount: 1, members: [person('acct_b')] },
    ] } },
  });
  const groups = (await client.results('4821')).groups ?? [];
  assert.deepEqual(groups[0].members, []);
  assert.equal(groups[1].members?.length, 1);
});
