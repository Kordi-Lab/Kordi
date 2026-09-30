import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canonicalStateFromStore,
  type CanonicalStore,
} from '../src/features/canonical/canonicalStore';
import type {
  CanonicalSessionCatalog,
  CanonicalSessionMessage,
} from '../src/kordi-app/types';

function message(
  id: string,
  sessionId: string,
  sequenceNum: number,
): CanonicalSessionMessage {
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

function catalogWithSessions(sessionIds: readonly string[]): CanonicalSessionCatalog {
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
    sessions: sessionIds.map((id) => ({
      id,
      kind: 'group' as const,
      title: id,
      status: 'active' as const,
      createdByIdentityId: 'human:me',
      createdAtMs: 1,
      updatedAtMs: 1,
      lastMessageAtMs: 1,
    })),
    participants: [],
    delegatedExchanges: [],
    presence: [],
    summaries: [],
  };
}

function storeWith(
  sessionIds: readonly string[],
  messagesPerSession: number,
  extra: Record<string, CanonicalSessionMessage[]> = {},
): CanonicalStore {
  const messagesBySessionId: Record<string, CanonicalSessionMessage[]> = { ...extra };
  for (const sessionId of sessionIds) {
    messagesBySessionId[sessionId] = Array.from(
      { length: messagesPerSession },
      (_unused, index) => message(`${sessionId}:m${index}`, sessionId, index),
    );
  }
  return {
    catalog: catalogWithSessions(sessionIds),
    messagesBySessionId,
    hydrationBySessionId: {},
    hasOlderBySessionId: {},
  };
}

test('canonical state projection groups sessions in catalog order with history sorted inside each session', () => {
  const store = storeWith(['session:b', 'session:a'], 3);

  const state = canonicalStateFromStore(store);

  assert.ok(state, 'expected a projected canonical state');
  assert.deepEqual(
    state.messages.map((entry) => entry.id),
    [
      'session:b:m0', 'session:b:m1', 'session:b:m2',
      'session:a:m0', 'session:a:m1', 'session:a:m2',
    ],
    'catalog order drives session order while each session keeps its own history order',
  );
});

test('canonical state projection keeps sessions missing from the catalog after catalog sessions', () => {
  const orphan = [message('orphan:m1', 'session:orphan', 1)];
  const store = storeWith(['session:a'], 2, { 'session:orphan': orphan });

  const state = canonicalStateFromStore(store);

  assert.ok(state, 'expected a projected canonical state');
  assert.deepEqual(
    state.messages.map((entry) => entry.id),
    ['session:a:m0', 'session:a:m1', 'orphan:m1'],
    'sessions outside the catalog must trail the ordered catalog sessions',
  );
});

test('canonical state projection does not re-sort history that is already ordered per session', () => {
  // Every incoming message rebuilds this projection. A global sort makes each
  // message cost O(total history), which is what degrades a long-lived window.
  // Sessions are hydrated in visit order, so insertion order routinely differs
  // from catalog order; a naive flatten then needs a real sort rather than
  // detecting one pre-sorted run.
  const sessionIds = Array.from({ length: 40 }, (_unused, index) => `session:${index}`);
  const hydrationOrder = [...sessionIds].reverse();
  const base = storeWith(hydrationOrder, 50);
  const store = { ...base, catalog: catalogWithSessions(sessionIds) };
  const totalMessages = sessionIds.length * 50;

  let comparisons = 0;
  const originalSort = Array.prototype.sort;
  Array.prototype.sort = function countingSort(this: unknown[], comparator?: never) {
    if (typeof comparator !== 'function') return originalSort.call(this, comparator);
    const counting = (left: unknown, right: unknown) => {
      comparisons += 1;
      return (comparator as (a: unknown, b: unknown) => number)(left, right);
    };
    return originalSort.call(this, counting as never);
  } as typeof Array.prototype.sort;

  try {
    canonicalStateFromStore(store);
  } finally {
    Array.prototype.sort = originalSort;
  }

  assert.ok(
    comparisons < totalMessages,
    `projecting ${totalMessages} already-ordered messages should not compare them all `
    + `(observed ${comparisons} comparisons)`,
  );
});

test('canonical state projection reuses its result while the store is unchanged', () => {
  const store = storeWith(['session:a', 'session:b'], 25);

  const first = canonicalStateFromStore(store);
  const second = canonicalStateFromStore(store);

  assert.ok(first && second, 'expected projected canonical states');
  assert.equal(
    first.messages,
    second.messages,
    'an unchanged store must not rebuild the flattened transcript array',
  );
});

test('a session repeated in the catalog does not repeat its transcript', () => {
  const base = storeWith(['session:a'], 2);
  const store = {
    ...base,
    catalog: {
      ...base.catalog,
      sessions: [...base.catalog.sessions, ...base.catalog.sessions],
    },
  };

  const state = canonicalStateFromStore(store);

  assert.ok(state, 'expected a projected canonical state');
  assert.deepEqual(
    state.messages.map((entry) => entry.id),
    ['session:a:m0', 'session:a:m1'],
    'each message must appear once regardless of catalog duplicates',
  );
});
