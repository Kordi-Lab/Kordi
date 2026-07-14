import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  applyCanonicalSessionStateAction,
  beginCanonicalSessionHydration,
  canonicalStateFromStore,
  createCanonicalStore,
  mergeCanonicalCatalog,
  mergeCanonicalMessagePage,
  mergeCanonicalStateIntoStore,
} from '../src/features/canonical/canonicalStore';
import type {
  CanonicalMessagePage,
  CanonicalSessionCatalog,
  CanonicalSessionMessage,
} from '../src/kordi-app/types';

function message(id: string, sessionId: string, sequenceNum: number): CanonicalSessionMessage {
  return {
    id,
    sessionId,
    senderIdentityId: 'human:me',
    senderRole: 'user',
    messageKind: 'text',
    contentText: id,
    content: {},
    status: 'sent',
    sequenceNum,
    createdAtMs: sequenceNum,
    updatedAtMs: sequenceNum,
  };
}

function catalog(): CanonicalSessionCatalog {
  return {
    storagePath: '/tmp/canonical.sqlite',
    profile: {
      id: 'profile',
      humanIdentityId: 'human:me',
      storageRoot: '/tmp',
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    identities: [],
    sessions: [{
      id: 'session:one',
      kind: 'group',
      title: 'One',
      status: 'active',
      createdByIdentityId: 'human:me',
      createdAtMs: 1,
      updatedAtMs: 3,
      lastMessageAtMs: 3,
    }],
    participants: [],
    delegatedExchanges: [],
    presence: [],
    summaries: [{
      sessionId: 'session:one',
      messageCount: 3,
      latestMessage: message('m3', 'session:one', 3),
      contextSnapshotCount: 0,
    }],
  };
}

test('catalog hydration exposes latest rows immediately while transcripts remain cold', () => {
  const store = mergeCanonicalCatalog(createCanonicalStore(), catalog());

  assert.equal(store.catalog?.summaries[0]?.messageCount, 3);
  assert.equal(store.hydrationBySessionId['session:one'], 'cold');
  assert.deepEqual(store.messagesBySessionId['session:one']?.map((item) => item.id), ['m3']);
  assert.deepEqual(canonicalStateFromStore(store)?.messages.map((item) => item.id), ['m3']);
});

test('message pages dedupe by id, preserve chronological order, and retain ready rows on empty refresh', () => {
  let store = mergeCanonicalCatalog(createCanonicalStore(), catalog());
  store = beginCanonicalSessionHydration(store, 'session:one');
  assert.equal(store.hydrationBySessionId['session:one'], 'loading');
  assert.deepEqual(store.messagesBySessionId['session:one']?.map((item) => item.id), ['m3']);

  const page: CanonicalMessagePage = {
    sessionId: 'session:one',
    messages: [message('m1', 'session:one', 1), message('m2', 'session:one', 2), message('m3', 'session:one', 3)],
    oldestSequenceNum: 1,
    newestSequenceNum: 3,
    hasOlder: false,
  };
  store = mergeCanonicalMessagePage(store, page);
  assert.equal(store.hydrationBySessionId['session:one'], 'ready');
  assert.deepEqual(store.messagesBySessionId['session:one']?.map((item) => item.id), ['m1', 'm2', 'm3']);

  store = mergeCanonicalMessagePage(store, {
    sessionId: 'session:one',
    messages: [],
    oldestSequenceNum: null,
    newestSequenceNum: null,
    hasOlder: false,
  });
  assert.deepEqual(store.messagesBySessionId['session:one']?.map((item) => item.id), ['m1', 'm2', 'm3']);
});

test('an older page prepends without replacing the existing ready tail', () => {
  let store = mergeCanonicalCatalog(createCanonicalStore(), catalog());
  store = mergeCanonicalMessagePage(store, {
    sessionId: 'session:one',
    messages: [message('m2', 'session:one', 2), message('m3', 'session:one', 3)],
    oldestSequenceNum: 2,
    newestSequenceNum: 3,
    hasOlder: true,
  });
  store = mergeCanonicalMessagePage(store, {
    sessionId: 'session:one',
    messages: [message('m1', 'session:one', 1), message('m2', 'session:one', 2)],
    oldestSequenceNum: 1,
    newestSequenceNum: 2,
    hasOlder: false,
  });

  assert.deepEqual(store.messagesBySessionId['session:one']?.map((item) => item.id), ['m1', 'm2', 'm3']);
  assert.equal(store.hasOlderBySessionId['session:one'], false);
});

test('an empty terminal page clears stale has-older state without deleting loaded rows', () => {
  let store = mergeCanonicalCatalog(createCanonicalStore(), catalog());
  store = mergeCanonicalMessagePage(store, {
    sessionId: 'session:one',
    messages: [message('m2', 'session:one', 2), message('m3', 'session:one', 3)],
    oldestSequenceNum: 2,
    newestSequenceNum: 3,
    hasOlder: true,
  });
  store = mergeCanonicalMessagePage(store, {
    sessionId: 'session:one',
    messages: [],
    oldestSequenceNum: null,
    newestSequenceNum: null,
    hasOlder: false,
  });

  assert.deepEqual(store.messagesBySessionId['session:one']?.map((item) => item.id), ['m2', 'm3']);
  assert.equal(store.hasOlderBySessionId['session:one'], false);
});

test('local readable message deltas keep catalog counts and latest rows current', () => {
  let store = mergeCanonicalCatalog(createCanonicalStore(), catalog());
  const currentState = canonicalStateFromStore(store);
  assert.ok(currentState);
  const pending = { ...message('m4', 'session:one', 4), status: 'sending' };

  store = mergeCanonicalStateIntoStore(store, {
    ...currentState,
    messages: [...currentState.messages, pending],
  });
  assert.equal(store.catalog?.summaries[0]?.messageCount, 3);
  assert.equal(store.catalog?.summaries[0]?.latestMessage?.id, 'm3');

  const pendingState = canonicalStateFromStore(store);
  assert.ok(pendingState);
  store = mergeCanonicalStateIntoStore(store, {
    ...pendingState,
    messages: pendingState.messages.map((item) => (
      item.id === 'm4' ? { ...item, status: 'sent', updatedAtMs: 5 } : item
    )),
  });

  assert.equal(store.catalog?.summaries[0]?.messageCount, 4);
  assert.equal(store.catalog?.summaries[0]?.latestMessage?.id, 'm4');
});

test('canonical session state adapter preserves the store for functional no-op updates', () => {
  const store = mergeCanonicalCatalog(createCanonicalStore(), catalog());

  const next = applyCanonicalSessionStateAction(store, (current) => current);

  assert.equal(next, store);
});

test('product startup and Cloud replay no longer invoke the full canonical snapshot command', () => {
  const appSource = readFileSync(new URL('../src/app/useKordiAppModel.ts', import.meta.url), 'utf8');
  const cloudSource = readFileSync(new URL('../src/features/cloud/useCloudBridgeState.ts', import.meta.url), 'utf8');

  assert.doesNotMatch(appSource, /fetchCanonicalSessionState/);
  assert.doesNotMatch(cloudSource, /fetchCanonicalSessionState/);
  assert.doesNotMatch(appSource, /desktopCanonicalRefreshKey|bridgeCanonicalRefreshKey/);
  assert.match(appSource, /fetchCanonicalSessionCatalog/);
  assert.match(appSource, /fetchCanonicalSessionMessages/);
});
