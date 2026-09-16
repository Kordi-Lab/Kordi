import assert from 'node:assert/strict';
import test from 'node:test';

import {
  mapCanonicalMessageCached,
} from '../src/features/canonical/readModel/messageMapping';
import type { CanonicalIdentity, CanonicalSessionMessage } from '../src/kordi-app/types';

function message(
  overrides: Partial<CanonicalSessionMessage> = {},
): CanonicalSessionMessage {
  return {
    id: 'm1',
    sessionId: 'session:one',
    senderIdentityId: 'human:me',
    senderRole: 'user',
    messageKind: 'text',
    contentText: 'hello',
    content: {},
    status: 'sent',
    sequenceNum: 1,
    createdAtMs: 1,
    updatedAtMs: 1,
    ...overrides,
  } as CanonicalSessionMessage;
}

function identities(): Map<string, CanonicalIdentity> {
  return new Map<string, CanonicalIdentity>([
    ['human:me', {
      id: 'human:me',
      kind: 'human',
      displayName: 'Me',
    } as CanonicalIdentity],
  ]);
}

test('mapping an unchanged message reuses the previous result object', () => {
  const identityById = identities();
  const row = message();

  const first = mapCanonicalMessageCached(row, identityById, 'human:me', {});
  const second = mapCanonicalMessageCached(row, identityById, 'human:me', {});

  assert.ok(first, 'expected the message to map to a view model');
  assert.equal(
    first,
    second,
    'an unchanged message must keep one stable object so rendering can skip it',
  );
});

test('mapping a replaced message rebuilds its result', () => {
  const identityById = identities();

  const first = mapCanonicalMessageCached(message(), identityById, 'human:me', {});
  const second = mapCanonicalMessageCached(
    message({ contentText: 'edited' }),
    identityById,
    'human:me',
    {},
  );

  assert.ok(first && second, 'expected both messages to map');
  assert.notEqual(first, second, 'a replaced message must not reuse a stale result');
  assert.equal(second.text, 'edited');
});

test('mapping rebuilds when the identity table changes', () => {
  const row = message();

  const first = mapCanonicalMessageCached(row, identities(), 'human:me', {});
  const second = mapCanonicalMessageCached(row, identities(), 'human:me', {});

  assert.ok(first && second, 'expected both calls to map');
  assert.notEqual(
    first,
    second,
    'a rebuilt identity table may rename senders, so the result must be recomputed',
  );
});

test('mapping rebuilds when a consulted reply target changes', () => {
  const identityById = identities();
  const row = message({ parentMessageId: 'm0' });

  const first = mapCanonicalMessageCached(row, identityById, 'human:me', {
    visibleReplyTargetByMessageId: new Map([['m0', 'visible-a']]),
  });
  const second = mapCanonicalMessageCached(row, identityById, 'human:me', {
    visibleReplyTargetByMessageId: new Map([['m0', 'visible-b']]),
  });

  assert.ok(first && second, 'expected both calls to map');
  assert.notEqual(
    first,
    second,
    'a changed reply target feeds the result, so a rebuilt map must invalidate it',
  );
  assert.equal(second.replyToMessageId, 'visible-b');
});

test('mapping reuses the result when an unrelated context entry changes', () => {
  const identityById = identities();
  const row = message();

  const first = mapCanonicalMessageCached(row, identityById, 'human:me', {
    visibleReplyTargetByMessageId: new Map([['other', 'visible-a']]),
  });
  const second = mapCanonicalMessageCached(row, identityById, 'human:me', {
    visibleReplyTargetByMessageId: new Map([['other', 'visible-b']]),
  });

  assert.ok(first, 'expected the message to map');
  assert.equal(
    first,
    second,
    'context this message never consulted must not invalidate its cached result',
  );
});

test('the recorded context map still behaves like a map', () => {
  // The recorder wraps the caller's map. If it replaced it with a bare object
  // carrying only get(), any other lookup inside the mapper would throw.
  const identityById = identities();
  const consulted: string[] = [];
  const replyTargets = new Map([['m0', 'visible-a']]);
  const observed = new Proxy(replyTargets, {
    get(target, property, receiver) {
      if (typeof property === 'string') consulted.push(property);
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  const mapped = mapCanonicalMessageCached(
    message({ parentMessageId: 'm0' }),
    identityById,
    'human:me',
    { visibleReplyTargetByMessageId: observed },
  );

  assert.ok(mapped, 'expected the message to map');
  assert.equal(mapped.replyToMessageId, 'visible-a');
  assert.ok(
    consulted.includes('get'),
    'the mapper should read the caller map through its own accessor',
  );
  assert.equal(replyTargets.size, 1, 'wrapping must not disturb the caller map');
});
