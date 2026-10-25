import assert from 'node:assert/strict';
import { test } from 'node:test';

import { act, createElement, useSyncExternalStore } from 'react';

import { PairCodePanel } from '../src/features/commonGround/PairCodePanel';
import { CommonGroundStore } from '../src/features/commonGround/store';

import { mockServer, owner, profile, room } from './helpers/commonGroundServer';
import { installDom } from './helpers/transcriptAttachmentDom';

const work = profile('cgp_work', 'work', 'Work', true);
const workshops = profile('cgp_ws', 'custom', 'Workshops', true);

function Panel({ store }: { store: CommonGroundStore }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return createElement(PairCodePanel, { state, store });
}

/** Mounts the panel; React DOM loads after the window exists so it listens for input events. */
async function withPanel(store: CommonGroundStore, run: (host: HTMLElement) => Promise<void>) {
  const installed = installDom();
  const { createRoot } = await import('react-dom/client');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(Panel, { store })));
    await run(host);
  } finally {
    await act(async () => root.unmount());
    installed.restore();
  }
}

async function type(host: HTMLElement, code: string) {
  for (const [index, digit] of code.split('').entries()) {
    const input = host.querySelector<HTMLInputElement>(`input[aria-label="Digit ${index + 1}"]`);
    assert.ok(input);
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, digit);
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  }
}

const button = (host: HTMLElement) => host.querySelector<HTMLButtonElement>('.cg-paircode .cg-pair-row.is-code button');

async function press(host: HTMLElement) {
  await act(async () => {
    button(host)!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

test('pair code: four digits turn Create into Enter pair room, which joins with the suggested card and opens the room', async () => {
  const { calls, client } = mockServer({
    'GET rooms/5160/preview': { status: 200, body: { code: '5160', name: 'Poster session 2026', kind: 'custom', memberCount: 14 } },
    'POST rooms/5160/join': { status: 200, body: room('5160', { name: 'Poster session 2026' }) },
    'GET rooms': { status: 200, body: { rooms: [] } },
  });
  const store = new CommonGroundStore(client, { profiles: true });
  store.set({ profiles: [work, workshops], profileId: 'cgp_work', owner: owner(), loaded: true });
  await withPanel(store, async (host) => {
    assert.equal(button(host)?.textContent, 'Create');
    await type(host, '516');
    assert.equal(button(host)?.textContent, 'Create');
    await type(host, '5160');
    assert.equal(button(host)?.textContent, 'Enter pair room');
    assert.equal(host.querySelector('.cg-pair-confirm'), null);
    await press(host);
    assert.deepEqual(calls.find((call) => call.url.endsWith('/rooms/5160/join'))?.body, { profileId: 'cgp_ws', kind: 'custom' });
    assert.deepEqual(store.top(), { name: 'lobby', code: '5160' });
    assert.equal(button(host)?.textContent, 'Create');
  });
});

test('pair code: Enter pair room opens a room you are in, and a code with no room turns the boxes red', async () => {
  const { calls, client } = mockServer({
    'GET rooms/0000/preview': { status: 404, body: { errorCode: 'common_ground_room_not_found', message: 'Room not found.' } },
  });
  const store = new CommonGroundStore(client, { profiles: true });
  store.set({
    profiles: [work], profileId: 'cgp_work', owner: owner(), loaded: true,
    roomList: [{ code: '3907', name: 'Lab lunch', open: true, memberCount: 5, joinedAt: '', lastActivityAt: '', themeCount: 0 }],
  });
  await withPanel(store, async (host) => {
    await type(host, '0000');
    await press(host);
    assert.ok(host.querySelector('.cg-digits.is-missing'));
    assert.equal(button(host)?.textContent, 'Create');
    await type(host, '3907');
    assert.equal(host.querySelector('.cg-digits.is-missing'), null);
    await press(host);
    assert.deepEqual(store.top(), { name: 'results', code: '3907' });
    assert.equal(calls.some((call) => call.url.includes('/join')), false);
  });
});
