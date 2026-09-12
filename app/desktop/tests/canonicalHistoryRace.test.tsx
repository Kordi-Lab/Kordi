import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { useKordiCanonicalSessionStore } from '../src/app/useKordiCanonicalSessionStore';
import type { CanonicalMessagePage, CanonicalSessionCatalog, CanonicalSessionMessage } from '../src/kordi-app/types';
import { installDom } from './helpers/transcriptAttachmentDom';
import { waitForReactCondition } from './helpers/waitForReactCondition';

const sessionId = 'session:group:race';
const message = (sequence: number): CanonicalSessionMessage => ({ id: `m${sequence}`, sessionId, senderIdentityId: 'human:test', senderRole: 'person', messageKind: 'text', contentText: 'Synthetic', status: 'received', sequenceNum: sequence, createdAtMs: sequence, updatedAtMs: sequence });
const page = (start: number, count: number, hasOlder: boolean): CanonicalMessagePage => ({ sessionId, messages: Array.from({ length: count }, (_, i) => message(start + i)), oldestSequenceNum: start, newestSequenceNum: start + count - 1, hasOlder });
function catalog(title = 'Current'): CanonicalSessionCatalog {
  return { storagePath: '', profile: { id: 'profile', humanIdentityId: 'human:test', storageRoot: '', createdAtMs: 1, updatedAtMs: 1 }, identities: [], sessions: [{ id: sessionId, kind: 'group', title, status: 'active', createdByIdentityId: 'human:test', createdAtMs: 1, updatedAtMs: 1 }], participants: [], delegatedExchanges: [], presence: [], summaries: [{ sessionId, messageCount: 100, latestMessage: message(100), contextSnapshotCount: 0 }] };
}

test('an older-page request waits for initial hydration and uses the resulting boundary', async () => {
  const dom = installDom();
  let resolveInitial!: (value: CanonicalMessagePage) => void;
  const requests: Array<Record<string, unknown>> = [];
  mockIPC((command, payload) => {
    if (command === 'desktop_canonical_session_catalog') return catalog();
    assert.equal(command, 'desktop_canonical_session_messages');
    const args = payload as Record<string, unknown>; requests.push(args);
    return requests.length === 1 ? new Promise<CanonicalMessagePage>(resolve => { resolveInitial = resolve; }) : page(1, 50, false);
  });
  let store!: ReturnType<typeof useKordiCanonicalSessionStore>;
  function Harness() { store = useKordiCanonicalSessionStore({ accountId: 'A', isNativeShell: true }); return null; }
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(Harness)));
    await waitForReactCondition(() => Boolean(store.store.catalog), 'catalog must load');
    let initial!: ReturnType<typeof store.hydrateSessionPage>;
    await act(async () => { initial = store.hydrateSessionPage(sessionId); });
    await waitForReactCondition(() => requests.length === 1, 'initial page must start');
    let older!: Promise<void>;
    await act(async () => { older = store.loadOlderSessionMessages(sessionId); });
    assert.equal(requests.length, 1);
    await act(async () => { resolveInitial(page(51, 50, true)); await Promise.all([initial, older]); });
    assert.equal((requests[1].beforeTimeline as { id: string }).id, 'm51');
    assert.equal(store.store.messagesBySessionId[sessionId].length, 100);
  } finally { resolveInitial?.(page(51, 50, true)); await act(async () => root.unmount()); clearMocks(); dom.restore(); }
});

test('catalog replies from an earlier account visit cannot overwrite a later visit', async () => {
  const dom = installDom();
  let resolveFirst!: (value: CanonicalSessionCatalog) => void;
  let calls = 0;
  mockIPC(command => {
    assert.equal(command, 'desktop_canonical_session_catalog');
    calls += 1;
    return calls === 1 ? new Promise<CanonicalSessionCatalog>(resolve => { resolveFirst = resolve; }) : catalog(calls === 2 ? 'B' : 'Fresh A');
  });
  let store!: ReturnType<typeof useKordiCanonicalSessionStore>;
  function Harness({ accountId }: { accountId: string }) { store = useKordiCanonicalSessionStore({ accountId, isNativeShell: true }); return null; }
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(Harness, { accountId: 'A' })));
    await waitForReactCondition(() => calls === 1, 'A must start');
    await act(async () => root.render(createElement(Harness, { accountId: 'B' })));
    await waitForReactCondition(() => store.store.catalog?.sessions[0].title === 'B', 'B must have an independent flight');
    await act(async () => root.render(createElement(Harness, { accountId: 'A' })));
    await waitForReactCondition(() => store.store.catalog?.sessions[0].title === 'Fresh A', 'new A must load');
    await act(async () => { resolveFirst(catalog('Stale A')); await new Promise<void>(resolve => setImmediate(resolve)); });
    assert.equal(store.store.catalog?.sessions[0].title, 'Fresh A');
  } finally { resolveFirst?.(catalog()); await act(async () => root.unmount()); clearMocks(); dom.restore(); }
});
