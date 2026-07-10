import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';

import { buildCanonicalIndexes } from '../src/features/canonical/readModel/indexes';
import {
  buildScaleCanonicalState,
  scaleSessionId,
} from './fixtures/chatScale';

test('canonical index construction stays linear for a 16,000-row transcript', () => {
  const base = buildScaleCanonicalState();
  const sessionId = scaleSessionId(0);
  const messages = base.messages.slice(0, 16_000).map((message) => ({
    ...message,
    sessionId,
  }));
  const state = {
    ...base,
    sessions: [base.sessions[0]!],
    participants: base.participants.filter((participant) => participant.sessionId === sessionId),
    messages,
  };

  const startedAt = performance.now();
  const indexes = buildCanonicalIndexes(state);
  const elapsedMs = performance.now() - startedAt;

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
  assert.ok(elapsedMs < 250, `Expected 16,000 canonical rows below 250ms, received ${elapsedMs.toFixed(1)}ms`);
});
