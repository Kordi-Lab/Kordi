import assert from 'node:assert/strict';
import test from 'node:test';

import { act, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { CloudMemory } from '../src/features/cloud/cloudMemoryClient';
import { memoryRoutingAvailable } from '../src/features/cloud/memoryCapability';
import { CardMemories } from '../src/features/commonGround/CardMemories';
import { CardScreen } from '../src/features/commonGround/CardScreen';
import { routedMemoryOf } from '../src/features/commonGround/client';
import { CommonGroundStore } from '../src/features/commonGround/store';
import { addMemoryToCard, cardChoices, newMemoriesLine, removeMemory, removeMemoryFromCard } from '../src/features/commonGround/storeMemories';
import type { CgRoutedMemory } from '../src/features/commonGround/types';
import { createAccountMemoryClient, type AccountMemoryAuthClient, type AccountMemoryRoutes } from '../src/features/memory/accountMemoryClient';
import { MEMORY_CATEGORIES, memoryCategoryLabel } from '../src/features/memory/memoryCategory';
import { createPreviewMemoryClient, type MemoryClient } from '../src/features/memory/memoryClient';
import { MemoryList } from '../src/features/memory/MemoryList';
import type { MemoryLesson } from '../src/features/memory/memoryModel';

import { card, mockServer, owner, profile } from './helpers/commonGroundServer';
import { withJsdomRoot } from './helpers/mountWithJsdom';
import { commonGroundFixtures } from './visual/commonGroundFixtures';

test('memory categories: every category has the label the iPhone uses, unknown ones none', () => {
  assert.deepEqual(MEMORY_CATEGORIES.map((category) => memoryCategoryLabel(category)), [
    'Preference', 'Goal', 'Health', 'Learning', 'Work', 'Shopping', 'Values', 'Location', 'Schedule', 'Task note',
  ]);
  assert.equal(memoryCategoryLabel('hcp-custom:other'), null);
  assert.equal(memoryCategoryLabel('toString'), null);
  assert.equal(memoryCategoryLabel(null), null);
  assert.equal(memoryCategoryLabel(undefined), null);
});

test('memory routing: available from memoryVersion 2', () => {
  assert.equal(memoryRoutingAvailable(null), false);
  assert.equal(memoryRoutingAvailable({}), false);
  assert.equal(memoryRoutingAvailable({ memoryVersion: 1 }), false);
  assert.equal(memoryRoutingAvailable({ memoryVersion: 2 }), true);
  assert.equal(memoryRoutingAvailable({ memoryVersion: 3 }), true);
});

const at = '2026-10-01T00:00:00.000Z';
const lesson = (lessonId: string, patch: Partial<MemoryLesson> = {}): MemoryLesson => ({
  lessonId, scope: 'global', scopeId: 'account', scopeLabel: 'Global', source: 'user_correction', text: `Memory ${lessonId}`, createdAt: at, updatedAt: at, ...patch,
});

test('memory rows: the category chip follows the date caption; no category, no chip', () => {
  const html = renderToStaticMarkup(createElement(MemoryList, {
    client: createPreviewMemoryClient({ latencyMs: 0 }),
    lessons: [lesson('a', { category: 'work_context' }), lesson('b')],
    onLessonsChange: () => undefined,
    emptyLabel: 'No memories yet.',
  }));
  assert.match(html, /From a correction · [^<]+<span data-memory-category="work_context"[^>]*>Work<\/span>/);
  assert.equal(html.split('data-memory-category').length - 1, 1);
});

test('memory rows: the preview memories carry categories, so every Memory surface shows chips', async () => {
  const lessons = await createPreviewMemoryClient({ latencyMs: 0 }).listLessons();
  assert.ok(lessons.every((entry) => memoryCategoryLabel(entry.category)));
});

function cloudMemory(patch: Partial<CloudMemory>): CloudMemory {
  return { memoryId: 'mem-1', scope: 'global', scopeId: 'account', scopeLabel: null, source: 'outcome', text: 'Runs on Tuesdays.', createdAt: at, updatedAt: at, ...patch };
}

test('account memory client: keeps the routing and card fields and changes them with PATCH', async () => {
  const calls: unknown[][] = [];
  const routes = {
    list: async () => ({
      memories: [
        cloudMemory({
          category: 'health_context', declarationType: 'model-inferred', confidence: 'high', profileId: 'cgp_health', profileKind: 'health',
          profileIds: ['cgp_health', 'cgp_lab'], excludedProfileIds: ['cgp_daily'],
        }),
        cloudMemory({ memoryId: 'mem-2', category: 'something_new' }),
      ],
      settings: { memoryEnabled: true, excludeSensitive: true },
    }),
    patch: async (token: string, memoryId: string, patch: unknown) => {
      calls.push([token, memoryId, patch]);
      return cloudMemory({ memoryId, category: 'work_context', profileIds: ['cgp_work'] });
    },
  } as unknown as AccountMemoryRoutes;
  const client: MemoryClient = createAccountMemoryClient({
    authClient: {} as AccountMemoryAuthClient,
    memoryRoutes: routes,
    loadSession: async () => ({ token: 'tok', accountId: 'acct', expiresAt: '2099-01-01T00:00:00Z' }),
    desktop: { isNativeShell: () => false } as never,
  });
  const [first, second] = await client.listLessons();
  assert.equal(first.category, 'health_context');
  assert.equal(first.declarationType, 'model-inferred');
  assert.equal(first.confidence, 'high');
  assert.equal(first.profileId, 'cgp_health');
  assert.equal(first.profileKind, 'health');
  assert.deepEqual(first.profileIds, ['cgp_health', 'cgp_lab']);
  assert.deepEqual(first.excludedProfileIds, ['cgp_daily']);
  assert.equal(second.category, undefined);
  assert.equal(second.profileIds, undefined);
  const changed = await client.updateMemoryCategory!('mem-1', 'work_context');
  await client.addMemoryToCard!('mem-1', 'cgp_lab');
  await client.removeMemoryFromCard!('mem-1', 'cgp_health');
  assert.deepEqual(calls, [
    ['tok', 'mem-1', { category: 'work_context' }],
    ['tok', 'mem-1', { addProfileId: 'cgp_lab' }],
    ['tok', 'mem-1', { removeProfileId: 'cgp_health' }],
  ]);
  assert.deepEqual(changed.profileIds, ['cgp_work']);
});

const memories: CgRoutedMemory[] = [
  { memoryId: 'm1', text: 'Reviewing the benchmark draft.', category: 'work_context', updatedAt: at, profileId: null, profileIds: ['cgp_work'], everyProfile: false },
  { memoryId: 'm2', text: 'Free 10:00 to 16:00 on weekdays.', category: 'coordination_context', updatedAt: at, profileId: null, profileIds: ['cgp_work', 'cgp_health'], everyProfile: true },
];
const profiles = [
  profile('cgp_work', 'work', 'Work', true),
  profile('cgp_health', 'health', 'Health', false),
  profile('cgp_lab', 'custom', 'Lab', false),
];

test('common ground client: profile memories parse, and the card changes and Delete call the memory routes', async () => {
  const server = mockServer({
    'GET profiles/cgp_work/memories': { status: 200, body: { memories: [{ ...memories[1] }, { memoryId: 'm3', text: 'Old row' }, { text: 'no id' }] } },
    'PATCH https://cloud.test/v1/cloud/memory/m1': { status: 200, body: { memory: {} } },
    'DELETE https://cloud.test/v1/cloud/memory/m1': { status: 204 },
  });
  const listed = await server.client.profileMemories('cgp_work');
  assert.deepEqual(listed, [memories[1], { memoryId: 'm3', text: 'Old row', category: null, updatedAt: '', profileId: null, profileIds: [], everyProfile: false }]);
  await server.client.addMemoryToCard('m1', 'cgp_lab');
  await server.client.removeMemoryFromCard('m1', 'cgp_work');
  await server.client.removeMemory('m1');
  assert.deepEqual(server.calls.slice(1).map((call) => [call.method, call.url, call.body]), [
    ['PATCH', 'https://cloud.test/v1/cloud/memory/m1', { addProfileId: 'cgp_lab' }],
    ['PATCH', 'https://cloud.test/v1/cloud/memory/m1', { removeProfileId: 'cgp_work' }],
    ['DELETE', 'https://cloud.test/v1/cloud/memory/m1', undefined],
  ]);
});

test('common ground fixtures: the sample memories parse as the server sends them', () => {
  const fx = commonGroundFixtures('dark');
  assert.deepEqual(fx.memories.map(routedMemoryOf), fx.memories);
  assert.equal(fx.memories.filter((memory) => memory.everyProfile).length, 1);
  assert.equal(fx.owner.memoriesSinceBuild, 3);
});

test('card memories: adding, removing from the card and deleting reload the card for the new-memories line', async () => {
  const server = mockServer({
    'PATCH https://cloud.test/v1/cloud/memory/m1': { status: 200, body: { memory: {} } },
    'DELETE https://cloud.test/v1/cloud/memory/m2': { status: 204 },
    'GET card?profile=cgp_work': { status: 200, body: owner({ memoriesSinceBuild: 0 }) },
  });
  const store = new CommonGroundStore(server.client, { profiles: true });
  store.set({ profiles, profileId: 'cgp_work', owner: owner({ memoriesSinceBuild: 2 }) });
  assert.equal(await addMemoryToCard(store, 'cgp_work', 'm1', 'cgp_lab'), true);
  assert.equal(await removeMemoryFromCard(store, 'cgp_work', 'm1'), true);
  assert.equal(await removeMemory(store, 'cgp_work', 'm2'), true);
  assert.deepEqual(server.calls.map((call) => [call.method, call.body]), [
    ['PATCH', { addProfileId: 'cgp_lab' }], ['GET', undefined],
    ['PATCH', { removeProfileId: 'cgp_work' }], ['GET', undefined],
    ['DELETE', undefined], ['GET', undefined],
  ]);
  assert.equal(store.getSnapshot().owner?.memoriesSinceBuild, 0);
});

test('card memories: Add to card… lists the other cards, checked when the memory is already on them', () => {
  assert.deepEqual(cardChoices(memories[0], profiles, 'cgp_work'), [
    { profileId: 'cgp_health', label: 'Health', on: false },
    { profileId: 'cgp_lab', label: 'Lab', on: false },
  ]);
  assert.deepEqual(cardChoices(memories[1], profiles, 'cgp_work'), [
    { profileId: 'cgp_health', label: 'Health', on: true },
    { profileId: 'cgp_lab', label: 'Lab', on: false },
  ]);
});

test('card memories: rows show the chip, the date and Every card; the card actions and Delete call back', async () => {
  const added: Array<[string, string]> = [];
  const removedFromCard: string[] = [];
  const deleted: string[] = [];
  const props = {
    memories, profiles, profileId: 'cgp_work',
    onAddToCard: (memoryId: string, target: string) => added.push([memoryId, target]),
    onRemoveFromCard: (memoryId: string) => removedFromCard.push(memoryId),
    onDelete: (memoryId: string) => deleted.push(memoryId),
  };
  await withJsdomRoot(async (mount) => {
    const host = await mount(createElement(CardMemories, { ...props, cardsEnabled: true }));
    assert.equal(host.querySelector('h3')?.textContent, 'Memories');
    const rows = [...host.querySelectorAll('.cg-mem')];
    assert.equal(rows.length, 2);
    assert.match(rows[0].textContent ?? '', /Work/);
    assert.doesNotMatch(rows[0].textContent ?? '', /Every card/);
    assert.match(rows[1].textContent ?? '', /Schedule.*· Every card/);
    assert.doesNotMatch(host.textContent ?? '', /Move to|No profile/);
    const click = async (element: Element | null | undefined) => {
      assert.ok(element);
      await act(async () => { (element as HTMLElement).click(); });
    };
    await click(rows[1].querySelector('[data-cg-add-card]'));
    const items = [...host.querySelectorAll('[role="menuitemcheckbox"]')];
    assert.deepEqual(items.map((item) => [item.textContent, item.getAttribute('aria-checked')]), [['Health', 'true'], ['Lab', 'false']]);
    await click(items[1]);
    assert.deepEqual(added, [['m2', 'cgp_lab']]);
    assert.equal(host.querySelector('[role="menu"]'), null);
    await click(rows[0].querySelector('[data-cg-remove-card]'));
    assert.deepEqual(removedFromCard, ['m1']);
    await click(rows[1].querySelector('[data-cg-delete-memory]'));
    assert.match(document.body.textContent ?? '', /Delete this memory\?/);
    const confirm = [...document.querySelectorAll('[role="dialog"] button')].find((button) => button.textContent === 'Delete');
    await click(confirm);
    assert.deepEqual(deleted, ['m2']);
  });
  // Below memoryVersion 3 the card actions stay hidden; Delete remains.
  const older = renderToStaticMarkup(createElement(CardMemories, props));
  assert.doesNotMatch(older, /Add to card|Remove from card/);
  assert.match(older, /Delete/);
  assert.equal(renderToStaticMarkup(createElement(CardMemories, { ...props, memories: [] })), '');
});

test('card page: the new-memories line shows with routing and a count, never at zero', () => {
  assert.equal(newMemoriesLine(0), null);
  assert.equal(newMemoriesLine(undefined), null);
  assert.equal(newMemoriesLine(1), '1 new memory');
  assert.equal(newMemoriesLine(3), '3 new memories');
  const render = (memoryRouting: boolean, memoriesSinceBuild: number) => {
    const store = new CommonGroundStore(mockServer({}).client, { profiles: true });
    store.set({ profiles, profileId: 'cgp_work', owner: owner({ card, memoriesSinceBuild }) });
    return renderToStaticMarkup(createElement(CardScreen, { state: store.getSnapshot(), store, memoryRouting }));
  };
  assert.match(render(true, 1), /<span data-cg-new-memories=""> · 1 new memory<\/span>/);
  assert.doesNotMatch(render(true, 0), /data-cg-new-memories/);
  assert.doesNotMatch(render(false, 4), /data-cg-new-memories/);
});
