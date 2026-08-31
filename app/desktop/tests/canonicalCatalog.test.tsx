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
  retainCanonicalSessionPages,
} from '../src/features/canonical/canonicalStore';
import { readKordiAppModelImplementationSource } from './helpers/appModelSource';
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

test('bounded state updates cannot shrink a ready transcript page', () => {
  let store = mergeCanonicalCatalog(createCanonicalStore(), catalog());
  store = mergeCanonicalMessagePage(store, {
    sessionId: 'session:one',
    messages: [
      message('m1', 'session:one', 1),
      message('m2', 'session:one', 2),
      message('m3', 'session:one', 3),
    ],
    oldestSequenceNum: 1,
    newestSequenceNum: 3,
    hasOlder: false,
  });
  const current = canonicalStateFromStore(store);
  assert.ok(current);

  store = mergeCanonicalStateIntoStore(store, {
    ...current,
    messages: [message('m3', 'session:one', 3)],
  });

  assert.equal(store.hydrationBySessionId['session:one'], 'ready');
  assert.deepEqual(
    store.messagesBySessionId['session:one']?.map((item) => item.id),
    ['m1', 'm2', 'm3'],
  );
});

test('background recovery cannot expand a ready transcript with older rows', () => {
  const base = catalog();
  let store = mergeCanonicalCatalog(createCanonicalStore(), {
    ...base,
    summaries: [{
      ...base.summaries[0]!,
      messageCount: 100,
      latestMessage: message('m100', 'session:one', 100),
    }],
  });
  store = mergeCanonicalMessagePage(store, {
    sessionId: 'session:one',
    messages: [
      message('m98', 'session:one', 98),
      message('m99', 'session:one', 99),
      message('m100', 'session:one', 100),
    ],
    oldestSequenceNum: 98,
    newestSequenceNum: 100,
    hasOlder: true,
  });
  const current = canonicalStateFromStore(store);
  assert.ok(current);
  const recoveredOlderRow = {
    ...message('recovered-m50', 'session:one', 101),
    createdAtMs: 50,
  };

  store = mergeCanonicalStateIntoStore(store, {
    ...current,
    messages: [...current.messages, recoveredOlderRow],
  });

  assert.equal(store.catalog?.summaries[0]?.messageCount, 100);
  assert.deepEqual(
    store.messagesBySessionId['session:one']?.map((item) => item.id),
    ['m98', 'm99', 'm100'],
  );
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

test('inactive canonical sessions retain only their catalog preview', () => {
  const base = catalog();
  const sessions = Array.from({ length: 10 }, (_, index) => ({
    ...base.sessions[0]!,
    id: `session-${index}`,
    title: `Session ${index}`,
  }));
  const summaries = sessions.map((session) => ({
    sessionId: session.id,
    messageCount: 2,
    latestMessage: message(`${session.id}-latest`, session.id, 2),
    contextSnapshotCount: 0,
  }));
  let store = mergeCanonicalCatalog(createCanonicalStore(), {
    ...base,
    sessions,
    summaries,
  });
  for (const session of sessions) {
    store = mergeCanonicalMessagePage(store, {
      sessionId: session.id,
      messages: [
        message(`${session.id}-first`, session.id, 1),
        message(`${session.id}-latest`, session.id, 2),
      ],
      oldestSequenceNum: 1,
      newestSequenceNum: 2,
      hasOlder: false,
    });
  }

  store = retainCanonicalSessionPages(
    store,
    new Set(sessions.slice(-8).map((session) => session.id)),
  );

  assert.deepEqual(
    store.messagesBySessionId['session-0']?.map((item) => item.id),
    ['session-0-latest'],
  );
  assert.equal(store.hydrationBySessionId['session-0'], 'cold');
  assert.equal(store.hasOlderBySessionId['session-0'], true);
  assert.deepEqual(
    store.messagesBySessionId['session-2']?.map((item) => item.id),
    ['session-2-first', 'session-2-latest'],
  );
  assert.equal(store.hydrationBySessionId['session-2'], 'ready');
});

test('hydration cannot replace a terminal agent turn with stale processing state', () => {
  const terminal: CanonicalSessionMessage = {
    ...message('agent-response', 'session:one', 4),
    senderIdentityId: 'agent:cloud:account:agent',
    senderRole: 'owned-agent',
    messageKind: 'agent-turn',
    contentText: 'Finished answer',
    content: { deliveryState: 'complete', requestId: 'request:one' },
    status: 'complete',
    updatedAtMs: 10,
  };
  let store = mergeCanonicalCatalog(createCanonicalStore(), catalog());
  store = mergeCanonicalMessagePage(store, {
    sessionId: 'session:one',
    messages: [terminal],
    oldestSequenceNum: 4,
    newestSequenceNum: 4,
    hasOlder: false,
  });

  const staleProcessing: CanonicalSessionMessage = {
    ...terminal,
    contentText: 'processing...',
    content: { deliveryState: 'processing', requestId: 'request:one' },
    status: 'processing',
    updatedAtMs: 20,
  };
  store = mergeCanonicalMessagePage(store, {
    sessionId: 'session:one',
    messages: [staleProcessing],
    oldestSequenceNum: 4,
    newestSequenceNum: 4,
    hasOlder: false,
  });

  assert.equal(
    store.messagesBySessionId['session:one']?.find(
      (item) => item.id === terminal.id,
    ),
    terminal,
  );
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
  const falseRenameNotice: CanonicalSessionMessage = {
    ...message('false-rename', 'session:one', 4),
    senderIdentityId: 'human:relay',
    senderRole: 'system',
    messageKind: 'status',
    contentText: 'Relay changed the session name to New chat',
    content: { kind: 'session-title-update', scope: 'session', title: 'New chat' },
    status: 'complete',
    sourceTransport: 'cloud-group-session-title-update',
  };

  store = mergeCanonicalStateIntoStore(store, {
    ...currentState,
    messages: [...currentState.messages, falseRenameNotice],
  });
  assert.equal(store.catalog?.summaries[0]?.messageCount, 3);
  assert.equal(store.catalog?.summaries[0]?.latestMessage?.id, 'm3');

  const stateWithoutFalseNoticeActivity = canonicalStateFromStore(store);
  assert.ok(stateWithoutFalseNoticeActivity);

  store = mergeCanonicalStateIntoStore(store, {
    ...stateWithoutFalseNoticeActivity,
    messages: [...stateWithoutFalseNoticeActivity.messages, pending],
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

test('equivalent native catalog refresh preserves the complete store reference', () => {
  const firstCatalog = catalog();
  const store = mergeCanonicalCatalog(createCanonicalStore(), firstCatalog);
  const replay = structuredClone(firstCatalog);

  const next = mergeCanonicalCatalog(store, replay);

  assert.equal(next, store);
  assert.equal(next.catalog, store.catalog);
  assert.equal(next.messagesBySessionId, store.messagesBySessionId);
  assert.equal(next.hydrationBySessionId, store.hydrationBySessionId);
});

test('duplicate hydration and message page results preserve the store reference', () => {
  let store = mergeCanonicalCatalog(createCanonicalStore(), catalog());
  store = beginCanonicalSessionHydration(store, 'session:one');
  assert.equal(beginCanonicalSessionHydration(store, 'session:one'), store);

  const page: CanonicalMessagePage = {
    sessionId: 'session:one',
    messages: [
      message('m1', 'session:one', 1),
      message('m2', 'session:one', 2),
      message('m3', 'session:one', 3),
    ],
    oldestSequenceNum: 1,
    newestSequenceNum: 3,
    hasOlder: false,
  };
  store = mergeCanonicalMessagePage(store, page);

  assert.equal(mergeCanonicalMessagePage(store, structuredClone(page)), store);
});

test('product startup and Cloud replay no longer invoke the full canonical snapshot command', () => {
  const appSource = readKordiAppModelImplementationSource();
  const canonicalStoreSource = readFileSync(new URL('../src/app/useKordiCanonicalSessionStore.ts', import.meta.url), 'utf8');
  const cloudSource = readFileSync(new URL('../src/features/cloud/useCloudCollaborationState.ts', import.meta.url), 'utf8');

  assert.doesNotMatch(appSource, /fetchCanonicalSessionState/);
  assert.doesNotMatch(canonicalStoreSource, /fetchCanonicalSessionState/);
  assert.doesNotMatch(cloudSource, /fetchCanonicalSessionState/);
  assert.doesNotMatch(appSource, /desktopCanonicalRefreshKey|bridgeCanonicalRefreshKey/);
  assert.match(canonicalStoreSource, /fetchCanonicalSessionCatalog/);
  assert.match(canonicalStoreSource, /fetchCanonicalSessionMessages/);
});
