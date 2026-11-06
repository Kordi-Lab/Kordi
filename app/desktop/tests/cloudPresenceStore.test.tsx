import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { act, createElement } from 'react';

import { CloudAuthClient, type CloudAccount } from '../src/features/cloud/authClient';
import type { CloudPresenceContactsResponse } from '../src/features/cloud/presence';
import { __setSessionBackendForTests, CLOUD_SESSION_SIGNED_OUT_EVENT, type StoredSession } from '../src/features/cloud/session';
import {
  __resetCloudPresenceStoresForTests,
  useCloudPresence,
  useContactPresenceLabel,
} from '../src/features/cloud/useCloudPresence';
import { withJsdomRoot } from './helpers/mountWithJsdom';
import { waitForReactCondition } from './helpers/waitForReactCondition';

const account = { accountId: 'acct_owner', displayName: 'Owner' } as CloudAccount;
const peerAccountId = 'acct_peer';
const session: StoredSession = { token: 'synthetic-token', accountId: account.accountId, expiresAt: '2099-01-01T00:00:00Z' };

/** Every label the header line rendered, in order, including the first render of each mount. */
function HeaderPresence({ log }: { log: (string | null)[] }) {
  const presence = useCloudPresence(account);
  const label = useContactPresenceLabel(presence.presenceForAccount(peerAccountId));
  log.push(label);
  return createElement('span', { 'data-presence': label ?? '' }, label);
}

function setUp(t: TestContext) {
  __resetCloudPresenceStoresForTests();
  __setSessionBackendForTests({ load: async () => session, save: async () => undefined, clear: async () => undefined });
  // Presence realtime has its own coverage; these tests read the polled snapshot.
  const originalWebSocket = globalThis.WebSocket;
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, writable: true, value: undefined });
  let release: (() => void) | null = null;
  const requests: number[] = [];
  t.mock.method(CloudAuthClient.prototype, 'listContactPresence', async (): Promise<CloudPresenceContactsResponse> => {
    requests.push(requests.length);
    if (requests.length === 1) await new Promise<void>((resolve) => { release = resolve; });
    return { accounts: [{ accountId: peerAccountId, status: 'online', updatedAt: '2026-11-05T12:00:00Z', lastSeenAt: null }] };
  });
  t.after(() => {
    Object.defineProperty(globalThis, 'WebSocket', { configurable: true, writable: true, value: originalWebSocket });
    __resetCloudPresenceStoresForTests();
    __setSessionBackendForTests(null);
  });
  return { requests, release: () => release?.() };
}

test('presence shows nothing until the first snapshot instead of a guessed "last seen recently"', async (t) => {
  const presence = setUp(t);
  await withJsdomRoot(async (mount) => {
    const log: (string | null)[] = [];
    const host = await mount(createElement(HeaderPresence, { log }));
    await waitForReactCondition(() => presence.requests.length === 1, 'presence request starts');
    assert.equal(host.querySelector('[data-presence]')?.textContent, '');
    await act(async () => { presence.release(); });
    await waitForReactCondition(() => host.querySelector('[data-presence]')?.textContent === 'online', 'presence arrives');
    assert.deepEqual([...new Set(log)], [null, 'online']);
  });
});

test('presence stays known when the page re-mounts, with no recently-seen frame in between', async (t) => {
  const presence = setUp(t);
  await withJsdomRoot(async (mount, root) => {
    const first: (string | null)[] = [];
    const host = await mount(createElement(HeaderPresence, { log: first }));
    await act(async () => { presence.release(); });
    await waitForReactCondition(() => host.querySelector('[data-presence]')?.textContent === 'online', 'presence arrives');
    // Switching tabs or pages unmounts the chat header and mounts a new one.
    await act(async () => { root.render(createElement('div')); });
    const second: (string | null)[] = [];
    await mount(createElement(HeaderPresence, { log: second }));
    assert.equal(second[0], 'online', 'the first render after a re-mount uses the known presence');
    assert.deepEqual([...new Set(second)], ['online']);
  });
});

test('signing out forgets presence so the next account starts unknown', async (t) => {
  const presence = setUp(t);
  await withJsdomRoot(async (mount) => {
    const log: (string | null)[] = [];
    const host = await mount(createElement(HeaderPresence, { log }));
    await act(async () => { presence.release(); });
    await waitForReactCondition(() => host.querySelector('[data-presence]')?.textContent === 'online', 'presence arrives');
    await act(async () => { window.dispatchEvent(new window.Event(CLOUD_SESSION_SIGNED_OUT_EVENT)); });
    assert.equal(host.querySelector('[data-presence]')?.textContent, '');
  });
});
