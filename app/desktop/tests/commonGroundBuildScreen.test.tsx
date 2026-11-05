import assert from 'node:assert/strict';
import { test } from 'node:test';

import { act, createElement, useSyncExternalStore } from 'react';

import { BuildScreen } from '../src/features/commonGround/BuildScreen';
import { emptySourcesMessage } from '../src/features/commonGround/buildRequest';
import { noPromptReason, privacySettingsUrl } from '../src/features/commonGround/deviceAccess';
import type { CgDeviceAccess, CgHost } from '../src/features/commonGround/host';
import { CommonGroundStore } from '../src/features/commonGround/store';

import { mockServer, owner, profile, type Reply } from './helpers/commonGroundServer';
import { installDom } from './helpers/transcriptAttachmentDom';

const work = profile('cgp_work', 'work', 'Work', false);
const noSources: Reply = { status: 400, body: { errorCode: 'common_ground_no_sources', message: 'Choose at least one source.' } };
const MEMORY_EMPTY = 'Memory has nothing for this card yet. Add a note or another source.';

function hostWith(patch: Partial<CgHost> = {}): CgHost {
  return {
    self: { accountId: 'acct_you', name: 'Alex Kim', avatarUrl: null },
    profiles: true,
    memoryAvailable: true,
    openChat: () => undefined,
    acceptRequest: async () => undefined,
    contactsChanged: () => undefined,
    openGroup: () => undefined,
    connectors: null,
    agentFiles: null,
    device: null,
    openUrl: () => undefined,
    ...patch,
  };
}

function storeWith(routes: Record<string, Reply | Reply[]>) {
  const server = mockServer(routes);
  const store = new CommonGroundStore(server.client, { profiles: true });
  store.set({ profiles: [work], profileId: work.profileId, owner: owner({ card: null, profile: work }), loaded: true });
  return { ...server, store };
}

function Screen({ store, host }: { store: CommonGroundStore; host: CgHost }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return createElement(BuildScreen, { state, store, host });
}

const settle = () => act(async () => { for (let index = 0; index < 6; index += 1) await new Promise((resolve) => setTimeout(resolve, 0)); });

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
const alertText = (root: ParentNode) => root.querySelector('[role="alert"]')?.textContent ?? null;

test('build: an empty Memory says Memory had nothing, not that no source is on', () => {
  const base = { memory: true, connectors: false, device: [], links: '', notes: '' };
  assert.equal(emptySourcesMessage(base), MEMORY_EMPTY);
  assert.equal(emptySourcesMessage({ ...base, connectors: true }), 'These sources have nothing for this card yet. Add a note or another source.');
});

test('build: Memory on with nothing to read shows the Memory message', async () => {
  const { store, calls } = storeWith({ 'POST card/build': noSources });
  await store.build({ memory: true, connectors: false, device: [], links: '', notes: '' });
  assert.equal(store.getSnapshot().notice, MEMORY_EMPTY);
  assert.equal((calls.find((call) => call.url.includes('card/build'))?.body as { memory?: boolean }).memory, true);
});

test('build screen: the error shows only after Build and clears when a source changes', async () => {
  const { store } = storeWith({ 'POST card/build': noSources });
  store.set({ notice: 'Could not load rooms.' });
  await mount(createElement(Screen, { store, host: hostWith() }), async (root) => {
    assert.equal(alertText(root), null, 'an earlier notice is not shown before Build');
    const build = buttonNamed(root, 'Build');
    assert.equal(build?.disabled, true, 'Build waits for a source');
    await click(root.querySelector('[role="switch"][aria-label="Memory"]'));
    assert.equal(buttonNamed(root, 'Build')?.disabled, false, 'Memory on counts as a source');
    await click(buttonNamed(root, 'Build'));
    assert.equal(alertText(root), MEMORY_EMPTY);
    assert.ok(alertText(root.querySelector('.cg-actions-center') ?? root), 'the error sits with Build');
    await click(root.querySelector('[role="switch"][aria-label="Memory"]'));
    assert.equal(alertText(root), null, 'a change to the sources clears it');
  });
});

function deviceWith(request: CgDeviceAccess['request']): CgDeviceAccess {
  return {
    status: async () => ({ calendar: 'not_determined', reminders: 'not_determined' }),
    request,
    titles: async () => [{ title: 'Standup', date: '2026-11-01' }],
  };
}

test('mac sources: Allow without a macOS prompt shows why, with System Settings', async () => {
  const opened: string[] = [];
  const { store } = storeWith({ 'POST card/build': noSources });
  const device = deviceWith(async () => ({ calendar: 'not_determined', reminders: 'not_determined' }));
  await mount(createElement(Screen, { store, host: hostWith({ device, openUrl: (url) => { opened.push(url); } }) }), async (root) => {
    await click(root.querySelector('button[aria-label="Allow Calendar"]'));
    assert.match(root.textContent ?? '', new RegExp(noPromptReason(false).replace('.', '\\.') + '|' + noPromptReason(true).replace('.', '\\.')));
    assert.equal(root.querySelector('button[aria-label="Allow Calendar"]'), null, 'no dead Allow button');
    assert.ok(root.querySelector('button[aria-label="Allow Reminders"]'), 'the other source is untouched');
    await click(root.querySelector('button[aria-label="Open System Settings for Calendar"]'));
    assert.deepEqual(opened, [privacySettingsUrl('calendar')]);
    await click(root.querySelector('[role="switch"][aria-label="Memory"]'));
    await click(buttonNamed(root, 'Build'));
    assert.ok(root.querySelector('button[aria-label="Open System Settings for Calendar"]'), 'the reason survives a Build attempt');
    assert.equal(root.querySelector('button[aria-label="Allow Calendar"]'), null);
  });
});

test('mac sources: a failed request shows its reason; a granted one reads titles and turns the source on', async () => {
  const { store } = storeWith({});
  const failing = deviceWith(async () => { throw new Error('Calendar connection requires macOS 14 or later. You can import ICS instead.'); });
  await mount(createElement(Screen, { store, host: hostWith({ device: failing }) }), async (root) => {
    await click(root.querySelector('button[aria-label="Allow Calendar"]'));
    assert.match(root.textContent ?? '', /requires macOS 14 or later/);
    assert.ok(root.querySelector('button[aria-label="Open System Settings for Calendar"]'));
    assert.ok(root.querySelector('button[aria-label="Allow Reminders"]'), 'the other source still reads its status');
  });
  let granted = false;
  const working: CgDeviceAccess = {
    status: async () => ({ calendar: granted ? 'granted' : 'not_determined', reminders: 'not_determined' }),
    request: async () => { granted = true; return { calendar: 'granted', reminders: 'not_determined' }; },
    titles: async () => [{ title: 'Standup', date: '2026-11-01' }],
  };
  await mount(createElement(Screen, { store, host: hostWith({ device: working }) }), async (root) => {
    await click(root.querySelector('button[aria-label="Allow Calendar"]'));
    assert.match(root.textContent ?? '', /1 titles/);
    assert.equal(root.querySelector('[role="switch"][aria-label="Calendar"]')?.getAttribute('aria-checked'), 'true');
    assert.equal(buttonNamed(root, 'Build')?.disabled, false);
  });
});

test('build screen: the card\'s last failed build shows on opening and clears when a source changes', async () => {
  const { store } = storeWith({});
  store.set({ owner: owner({ card: null, profile: work, build: { status: 'failed', errorCode: 'no_topics' } }) });
  await mount(createElement(Screen, { store, host: hostWith() }), async (root) => {
    assert.equal(alertText(root), 'Nothing here fits this profile. Add a note or choose other sources.');
    await click(root.querySelector('[role="switch"][aria-label="Memory"]'));
    assert.equal(alertText(root), null);
  });
});
