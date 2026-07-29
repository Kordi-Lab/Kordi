import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildCanonicalIndexes } from '../src/features/canonical/readModel/indexes';
import { mergeCanonicalHistoryIntoRuntime } from '../src/features/canonical/sessionReadModel';
import type { Message } from '../src/kordi-app/types';
import {
  buildScaleCanonicalState,
  scaleSessionId,
} from './fixtures/chatScale';
import { createPropertyReadCounter } from './helpers/propertyReadCounter';

test('canonical index construction stays linear for a 16,000-row transcript', () => {
  const base = buildScaleCanonicalState();
  const sessionId = scaleSessionId(0);
  const readCounter = createPropertyReadCounter();
  const messages = base.messages.slice(0, 16_000).map((message) => readCounter.track({
    ...message,
    sessionId,
  }));
  const state = {
    ...base,
    sessions: [base.sessions[0]!],
    participants: base.participants.filter((participant) => participant.sessionId === sessionId),
    messages,
  };

  const indexes = buildCanonicalIndexes(state);
  const propertyReads = readCounter.count();

  assert.equal(indexes.rawMessageCountBySessionId.get(sessionId), messages.length);
  const expectedLatestReadable = [...messages]
    .filter((message) => !['sending', 'processing'].includes(message.status))
    .sort((left, right) => left.sequenceNum - right.sequenceNum || left.createdAtMs - right.createdAtMs)
    .at(-1);
  const expectedLatestActivityAtMs = messages.reduce((latest, message) => (
    ['sending', 'processing'].includes(message.status) ? latest : Math.max(latest, message.createdAtMs)
  ), 0);
  assert.equal(indexes.latestReadableMessageBySessionId.get(sessionId)?.id, expectedLatestReadable?.id);
  assert.equal(indexes.latestActivityMessageBySessionId.get(sessionId)?.createdAtMs, expectedLatestActivityAtMs);
  assert.ok(
    propertyReads <= messages.length * 128,
    `Expected at most 128 indexed property reads per canonical row, received ${(propertyReads / messages.length).toFixed(1)}`,
  );
});

test('runtime transcript reconciliation stays subquadratic with 12,000 canonical overlays', () => {
  const rawRuntimeMessages: Message[] = Array.from({ length: 12_000 }, (_, index) => ({
    role: 'user',
    text: `runtime message ${index}`,
    time: String(index),
  }));
  const readCounter = createPropertyReadCounter();
  const runtimeMessages = rawRuntimeMessages.map((message) => readCounter.track(message));
  const canonicalMessages: Message[] = rawRuntimeMessages.flatMap((runtimeMessage, index) => [
    readCounter.track({
      id: `canonical-overlay:${index}`,
      role: 'user',
      text: `canonical-only message ${index}`,
      time: String(index),
    }),
    readCounter.track({
      id: `canonical-runtime:${index}`,
      ...runtimeMessage,
    }),
  ]);

  const merged = mergeCanonicalHistoryIntoRuntime(canonicalMessages, runtimeMessages);
  const propertyReads = readCounter.count();

  assert.equal(merged.length, 24_000);
  assert.equal(merged[0]?.text, 'canonical-only message 0');
  assert.equal(merged[1]?.text, 'runtime message 0');
  assert.equal(merged.at(-2)?.text, 'canonical-only message 11999');
  assert.equal(merged.at(-1)?.text, 'runtime message 11999');
  assert.ok(
    propertyReads <= runtimeMessages.length * 48,
    `Expected at most 48 indexed property reads per runtime row, received ${(propertyReads / runtimeMessages.length).toFixed(1)}`,
  );
});
