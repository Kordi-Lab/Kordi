import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import type { CloudAccount } from '../src/features/cloud/authClient';
import { useCanonicalActiveSessionRead } from '../src/features/cloud/useCanonicalActiveSessionRead';
import { createCanonicalSessionReadModel } from '../src/features/canonical/sessionReadModel';
import type { CanonicalReadCursorDelta, CanonicalSessionState } from '../src/kordi-app/types';
import { SidebarUnreadBadge } from '../src/pages/workspaceSidebar.shared';
import { conversation } from './helpers/workspaceSidebarParticipantSpacesFixtures';

const sessionId = 'session:group:read-latency';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(): CanonicalSessionState {
  return {
    storagePath: '',
    profile: { id: 'profile', humanIdentityId: 'human:me', storageRoot: '', createdAtMs: 1, updatedAtMs: 1 },
    identities: [
      { id: 'human:me', kind: 'human', displayName: 'Me', source: 'local', avatarKey: 'me', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'human:peer', kind: 'human', displayName: 'Peer', source: 'cloud', avatarKey: 'peer', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [{ id: sessionId, kind: 'group', title: 'Read test', status: 'active', createdByIdentityId: 'human:me', createdAtMs: 1, updatedAtMs: 1, metadata: { cloudUnreadCount: 1 } }],
    participants: [
      { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedAtMs: 1 },
      { sessionId, identityId: 'human:peer', role: 'person', state: 'active', addedAtMs: 1 },
    ],
    messages: [{ id: 'message:1', sessionId, senderIdentityId: 'human:peer', senderRole: 'person', messageKind: 'text', contentText: 'Synthetic unread message', status: 'complete', sequenceNum: 1, createdAtMs: 1, updatedAtMs: 1 }],
    delegatedExchanges: [], presence: [], contextSnapshots: [],
  };
}

function delta(sequence = 1): CanonicalReadCursorDelta {
  return { sessionId, identityId: 'human:me', lastSeenAtMs: sequence, lastReadMessageId: `message:${sequence}`, lastReadSequenceNum: sequence };
}

async function mount(options: { initialState?: CanonicalSessionState; presented?: boolean } = {}) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  const replacements = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(replacements).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(replacements)) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const localRequests: ReturnType<typeof deferred<CanonicalReadCursorDelta>>[] = [];
  const cloudRequests: ReturnType<typeof deferred<void>>[] = [];
  mockIPC((command) => {
    assert.equal(command, 'desktop_canonical_mark_session_read');
    const request = deferred<CanonicalReadCursorDelta>();
    localRequests.push(request);
    return request.promise;
  });
  const markRead = async () => {
    const request = deferred<void>();
    cloudRequests.push(request);
    return request.promise;
  };
  const host = document.getElementById('root')!;
  const root = createRoot(host);
  let state: CanonicalSessionState | null = options.initialState ?? fixture();
  let updateState!: React.Dispatch<React.SetStateAction<CanonicalSessionState | null>>;
  function Harness({ accountId, presented }: { accountId: string; presented: boolean }) {
    const [canonicalState, setCanonicalState] = useState(state);
    state = canonicalState;
    updateState = setCanonicalState;
    useCanonicalActiveSessionRead({
      account: { accountId } as CloudAccount,
      activeConversationId: sessionId,
      canMarkActiveConversationRead: presented,
      canonicalState,
      setCanonicalState,
      markRead,
    });
    const model = createCanonicalSessionReadModel(canonicalState);
    const view = model?.applyConversation(conversation({ id: sessionId, canonicalSessionId: sessionId, unread: 1 }), () => '');
    return <SidebarUnreadBadge count={view?.unread} scope="test-session" />;
  }
  let props = { accountId: 'account:one', presented: options.presented ?? true };
  const render = async (next: Partial<typeof props> = {}) => {
    props = { ...props, ...next };
    await act(async () => { root.render(<Harness {...props} />); });
  };
  await render();
  return {
    host, localRequests, cloudRequests, render,
    state: () => state!,
    setState: async (next: CanonicalSessionState) => { await act(async () => { updateState(next); }); },
    async close() {
      await act(async () => root.unmount());
      clearMocks();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
      dom.window.close();
    },
  };
}

test('publishes a persisted local read while cloud acknowledgment is still pending', async () => {
  const h = await mount();
  try {
    assert.ok(h.host.querySelector('[data-unread-count="1"]'));
    assert.equal(h.cloudRequests.length, 1);
    await act(async () => { h.localRequests[0].resolve(delta()); });
    assert.equal(h.host.querySelectorAll('[data-unread-count]').length, 0);
    assert.equal(h.state().participants[0].lastReadMessageId, 'message:1');
    await act(async () => { h.cloudRequests[0].resolve(); });
    assert.equal(h.cloudRequests.length, 1, 'publishing the local cursor must not resend the same read');
  } finally { await h.close(); }
});

test('cloud failure does not discard a successful local read', async () => {
  const h = await mount();
  try {
    await act(async () => { h.cloudRequests[0].reject(new Error('Synthetic offline response')); });
    await act(async () => { h.localRequests[0].resolve(delta()); });
    assert.equal(h.host.querySelectorAll('[data-unread-count]').length, 0);
  } finally { await h.close(); }
});

test('server acknowledgment alone does not invent a successful local read', async () => {
  const h = await mount();
  try {
    await act(async () => { h.cloudRequests[0].resolve(); });
    assert.ok(h.host.querySelector('[data-unread-count="1"]'));
    await act(async () => { h.localRequests[0].reject(new Error('Synthetic local failure')); });
    assert.equal(h.state().participants[0].lastReadMessageId, undefined);
    await h.setState({ ...h.state() });
    assert.equal(h.localRequests.length, 2, 'failed persistence can retry on the next reconciliation');
  } finally { await h.close(); }
});

test('a late read response from the previous account cannot clear the new account', async () => {
  const h = await mount();
  try {
    await h.render({ accountId: 'account:two', presented: false });
    await h.setState(fixture());
    await act(async () => {
      h.localRequests[0].resolve(delta());
      h.cloudRequests[0].resolve();
    });
    assert.ok(h.host.querySelector('[data-unread-count="1"]'));
    assert.equal(h.state().participants[0].lastReadMessageId, undefined);
  } finally { await h.close(); }
});

test('leaving the latest message preserves the completed read without hiding a newer message', async () => {
  const h = await mount();
  try {
    await h.render({ presented: false });
    const current = h.state();
    await h.setState({ ...current, messages: [...current.messages, { ...current.messages[0], id: 'message:2', sequenceNum: 2, createdAtMs: 2, updatedAtMs: 2 }] });
    await act(async () => { h.localRequests[0].resolve(delta()); });
    assert.equal(h.state().participants[0].lastReadMessageId, 'message:1');
    assert.ok(h.host.querySelector('[data-unread-count="1"]'));
    assert.equal(h.cloudRequests.length, 1, 'an unpresented newer message must not start a read');
  } finally { await h.close(); }
});

test('an older failed cloud read cannot invalidate a newer successful read', async () => {
  const h = await mount();
  try {
    const current = h.state();
    await h.setState({ ...current, messages: [...current.messages, { ...current.messages[0], id: 'message:2', sequenceNum: 2, createdAtMs: 2, updatedAtMs: 2 }] });
    await act(async () => {
      h.localRequests[1].resolve(delta(2));
      h.cloudRequests[1].resolve();
    });
    await act(async () => { h.cloudRequests[0].reject(new Error('Older request failed')); });
    await h.setState({ ...h.state() });
    assert.equal(h.cloudRequests.length, 2, 'the older failure must not force a duplicate read for the latest message');
    await act(async () => { h.localRequests[0].resolve(delta()); });
    assert.equal(h.state().participants[0].lastReadMessageId, 'message:2');
  } finally { await h.close(); }
});

test('an unfocused or scrolled-away transcript does not start a read', async () => {
  const h = await mount({ presented: false });
  try {
    assert.equal(h.localRequests.length, 0);
    assert.equal(h.cloudRequests.length, 0);
    assert.ok(h.host.querySelector('[data-unread-count="1"]'));
    await h.render({ presented: true });
    assert.equal(h.localRequests.length, 1);
    assert.equal(h.cloudRequests.length, 1);
  } finally { await h.close(); }
});

test('cloud repair runs when the local read cursor is already current', async () => {
  const initialState = fixture();
  initialState.participants[0].lastReadMessageId = 'message:1';
  const h = await mount({ initialState });
  try {
    assert.equal(h.localRequests.length, 0);
    assert.equal(h.cloudRequests.length, 1);
    assert.equal(h.host.querySelectorAll('[data-unread-count]').length, 0);
  } finally { await h.close(); }
});

test('cloud repair runs when the local message projection is not materialized', async () => {
  const h = await mount({ initialState: { ...fixture(), messages: [] } });
  try {
    assert.equal(h.localRequests.length, 0);
    assert.equal(h.cloudRequests.length, 1);
  } finally { await h.close(); }
});

test('returning to the same account does not accept a response from its previous lifetime', async () => {
  const h = await mount();
  try {
    await h.render({ accountId: 'account:two', presented: false });
    await h.render({ accountId: 'account:one' });
    await h.setState(fixture());
    await act(async () => {
      h.localRequests[0].resolve(delta());
      h.cloudRequests[0].resolve();
    });
    assert.ok(h.host.querySelector('[data-unread-count="1"]'));
    assert.equal(h.state().participants[0].lastReadMessageId, undefined);
  } finally { await h.close(); }
});
