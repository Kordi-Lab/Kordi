import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { BuildScreen } from '../src/features/commonGround/BuildScreen';
import { canBuildProfile, commonGroundBuildRequest, documentsSummary, initialPicks, NO_PICKS, type CgBuildChoices } from '../src/features/commonGround/buildRequest';
import type { CgHost } from '../src/features/commonGround/host';
import { ProfileCard } from '../src/features/commonGround/ProfileCard';
import { CommonGroundStore } from '../src/features/commonGround/store';
import { saveSources } from '../src/features/commonGround/storeProfiles';
import type { CgSourcePicks } from '../src/features/commonGround/types';
import { deckCards } from '../src/features/commonGround/wallet';

import { mockServer, owner, profile } from './helpers/commonGroundServer';

const saved: CgSourcePicks = {
  memory: true, connectors: ['gmail', 'slack'], device: ['calendar'], agents: false, documents: ['att_1', 'att_2'], links: 'kordi.ai', notes: '',
};

test('sources: the screen opens with the saved picks, and Rebuild from memory turns Memory on', () => {
  assert.deepEqual(initialPicks(null), NO_PICKS);
  assert.deepEqual(initialPicks(saved), saved);
  assert.deepEqual(initialPicks({ ...saved, memory: false }, true), saved);
  assert.equal(documentsSummary(0), 'None chosen');
  assert.equal(documentsSummary(2), '2 chosen');
});

test('sources: version 3 sends the providers, the documents and every saved pick', () => {
  const choices: CgBuildChoices = {
    memory: false, connectors: ['gmail'], useAgents: false, agentFiles: null, device: [], links: '', notes: '', documents: saved.documents, picks: saved,
  };
  const request = commonGroundBuildRequest(choices);
  assert.equal(request.connectors, true);
  assert.deepEqual(request.connectorProviders, ['gmail']);
  assert.deepEqual(request.documents, ['att_1', 'att_2']);
  assert.deepEqual(request.picks, saved, 'picks go unchanged, including ones this Mac cannot act on');
  const onlyDocuments = { ...choices, connectors: [], picks: { ...NO_PICKS, documents: ['att_1'] }, documents: ['att_1'] };
  assert.equal(canBuildProfile(onlyDocuments), true);
  assert.equal(canBuildProfile({ ...onlyDocuments, documents: [] }), false);
});

test('sources: picks save to the profile and documents list from the server', async () => {
  const { calls, client } = mockServer({
    'PUT profiles/cgp_work': { status: 200, body: profile('cgp_work', 'work', 'Work', true, { sources: saved }) },
    'GET documents': { status: 200, body: { documents: [{ attachmentId: 'att_1', title: 'Plan', updatedAt: '2026-10-18T09:00:00Z', sizeBytes: 120 }] } },
  });
  const store = new CommonGroundStore(client, { profiles: true });
  store.set({ profiles: [profile('cgp_work', 'work', 'Work', true)], profileId: 'cgp_work' });
  assert.equal(await saveSources(store, 'cgp_work', saved), true);
  assert.deepEqual(calls[0].body, { sources: saved });
  assert.deepEqual(store.getSnapshot().profiles[0].sources, saved);
  const documents = await client.documents();
  assert.equal(documents[0].title, 'Plan');
  assert.equal(await saveSources(store, 'cgp_gone', saved), false);
});

test('sources: Build shows Kordi, connected accounts and this Mac, with a small Build pill', () => {
  const { client } = mockServer({});
  const store = new CommonGroundStore(client, { profiles: true });
  store.set({ owner: owner({ card: null }), loaded: true, profiles: [profile('cgp_work', 'work', 'Work', false, { sources: saved })], profileId: 'cgp_work' });
  const host = {
    self: { accountId: 'me', name: 'Me', avatarUrl: null },
    profiles: true,
    sources: true,
    memoryAvailable: true,
    connectors: { client: { list: async () => ({ states: [] }), disconnect: async () => undefined }, openSettings: () => undefined },
    agentFiles: async () => [],
    device: null,
    openUrl: () => undefined,
  } as unknown as CgHost;
  const markup = renderToStaticMarkup(createElement(BuildScreen, { state: store.getSnapshot(), store, host }));
  for (const text of ['>Kordi<', '>Memory<', '>Documents<', '2 chosen', '>Connected accounts<', '>On this Mac<', '>Agents<', 'cg-build-pill']) {
    assert.ok(markup.includes(text), text);
  }
  assert.match(markup, /class="cg-build-pill"[^>]*>Build</);
  const older = renderToStaticMarkup(createElement(BuildScreen, { state: store.getSnapshot(), store, host: { ...host, sources: false } }));
  assert.equal(older.includes('>Documents<'), false);
});

test('cards: the owner name sits under the title and the handle by the bird', () => {
  const face = { design: 'work' as const, name: 'Work', focus: null, topicCount: 2, status: 'built' as const, owner: { name: 'Shu Yang', handle: 'shuyang' } };
  const tile = renderToStaticMarkup(createElement(ProfileCard, { face }));
  assert.match(tile, /class="cg-tile-owner">Shu Yang</);
  assert.match(tile, /class="cg-card-handle">@shuyang</);
  const large = renderToStaticMarkup(createElement(ProfileCard, { size: 'large', face, topics: ['Retrieval'] }));
  assert.match(large, /has-handle/);
  assert.match(large, /class="cg-large-owner">Shu Yang</);
  const noHandle = renderToStaticMarkup(createElement(ProfileCard, { face: { ...face, owner: { name: 'Shu Yang' } } }));
  assert.equal(noHandle.includes('cg-card-handle'), false);
  const state = new CommonGroundStore(mockServer({}).client, { profiles: true }).getSnapshot();
  assert.deepEqual(deckCards({ ...state, profiles: [profile('cgp_work', 'work', 'Work', true)] }, face.owner)[0].face.owner, face.owner);
});
