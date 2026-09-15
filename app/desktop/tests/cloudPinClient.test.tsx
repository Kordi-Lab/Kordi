import assert from 'node:assert/strict';
import { test } from 'node:test';
import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CloudAuthClient, type CloudAccount, type CloudSessionPin } from '../src/features/cloud/authClient';
import { __setSessionBackendForTests } from '../src/features/cloud/session';
import { useCloudActiveSessionPin } from '../src/features/cloud/useCloudActiveSessionPin';
import { installVirtualTranscriptHarness } from './support/virtualTranscriptHarness';

const sessionId = 'session:group:fixture';
const empty: CloudSessionPin = { sessionId, privateMessageId: null, sharedMessageId: null, effectiveMessageId: null, updatedAt: null };

test('session preparation reads pin state without waiting for paginated history', async () => {
  const paths: string[] = [];
  const client = new CloudAuthClient({ baseUrl: 'http://fixture', fetchImpl: async input => {
    paths.push(String(input));
    return Response.json({ pin: empty });
  } });
  assert.deepEqual(await client.getCloudSessionPinState('synthetic', sessionId), empty);
  assert.equal(paths.length, 1);
  assert.ok(paths[0].endsWith('/pin'));
});

test('active pin hydration rejects a previous account token and cannot overwrite a concurrent mutation', async () => {
  await installVirtualTranscriptHarness();
  let storedAccount = 'previous-account';
  __setSessionBackendForTests({ load: async () => ({ token: 'synthetic', accountId: storedAccount, expiresAt: '2099-01-01T00:00:00Z' }), save: async () => {}, clear: async () => {} });
  const account = { accountId: 'current-account' } as CloudAccount;
  let requests = 0;
  let complete!: (pin: CloudSessionPin) => void;
  const client = { getCloudSessionPin: () => { requests += 1; return new Promise<CloudSessionPin>(resolve => { complete = resolve; }); } } as unknown as CloudAuthClient;
  let current: Record<string, CloudSessionPin> = {};
  let update!: React.Dispatch<React.SetStateAction<Record<string, CloudSessionPin>>>;
  function Harness({ active }: { active: string }) {
    const [pins, setPins] = useState<Record<string, CloudSessionPin>>({});
    current = pins; update = setPins;
    useCloudActiveSessionPin({ account, activeConversationId: active, client, pinsBySessionId: pins, setPinsBySessionId: setPins });
    return null;
  }
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(<Harness active={sessionId} />));
    assert.equal(requests, 0, 'A previous account token must not be used for a newly selected account');
    storedAccount = account.accountId;
    __setSessionBackendForTests({ load: async () => ({ token: 'synthetic', accountId: storedAccount, expiresAt: '2099-01-01T00:00:00Z' }), save: async () => {}, clear: async () => {} });
    await act(async () => root.render(<Harness active={`${sessionId}-next`} />));
    assert.equal(requests, 1);
    const selected = `${sessionId}-next`;
    const latest = { ...empty, sessionId: selected, sharedMessageId: 'new-pin', effectiveMessageId: 'new-pin', updatedAt: '2026-09-15T12:00:00Z' };
    await act(async () => update({ [selected]: latest }));
    await act(async () => complete({ ...empty, sessionId: selected }));
    assert.equal(current[selected].effectiveMessageId, 'new-pin', 'Late legacy reads cannot clear newer pin state');
  } finally { await act(async () => root.unmount()); host.remove(); __setSessionBackendForTests(null); }
});


test('pin history rejects a cursor moving forward rather than repeatedly fetching pages', async () => {
  let requests = 0;
  const client = new CloudAuthClient({ baseUrl: 'http://fixture', fetchImpl: async () => {
    requests += 1;
    return Response.json({ events: [], nextBefore: requests === 1 ? 10 : 11 });
  } });
  await assert.rejects(client.getCloudPinHistory('synthetic', sessionId), /Invalid pin history cursor/);
  assert.equal(requests, 2);
});
