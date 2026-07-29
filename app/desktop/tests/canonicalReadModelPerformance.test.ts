import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildCanonicalIndexes } from '../src/features/canonical/readModel/indexes';
import { mergeCanonicalHistoryIntoRuntime } from '../src/features/canonical/sessionReadModel';
import type { Message } from '../src/kordi-app/types';
import {
  buildScaleCanonicalState,
  scaleSessionId,
} from './fixtures/chatScale';
import { measureCpuMs } from './helpers/cpuBudget';

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

  const { result: indexes, cpuMs } = measureCpuMs(() => buildCanonicalIndexes(state));

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
  assert.ok(cpuMs < 250, `Expected 16,000 canonical rows below 250 CPU ms, received ${cpuMs.toFixed(1)}ms`);
});

test('runtime transcript reconciliation stays subquadratic with 12,000 canonical overlays', () => {
  const runtimeMessages: Message[] = Array.from({ length: 12_000 }, (_, index) => ({
    role: 'user',
    text: `runtime message ${index}`,
    time: String(index),
  }));
  const canonicalMessages: Message[] = runtimeMessages.flatMap((runtimeMessage, index) => [
    {
      id: `canonical-overlay:${index}`,
      role: 'user',
      text: `canonical-only message ${index}`,
      time: String(index),
    },
    {
      id: `canonical-runtime:${index}`,
      ...runtimeMessage,
    },
  ]);

  const { result: merged, cpuMs } = measureCpuMs(
    () => mergeCanonicalHistoryIntoRuntime(canonicalMessages, runtimeMessages),
  );

  assert.equal(merged.length, 24_000);
  assert.equal(merged[0]?.text, 'canonical-only message 0');
  assert.equal(merged[1]?.text, 'runtime message 0');
  assert.equal(merged.at(-2)?.text, 'canonical-only message 11999');
  assert.equal(merged.at(-1)?.text, 'runtime message 11999');
  assert.ok(cpuMs < 250, `Expected 12,000 transcript overlays below 250 CPU ms, received ${cpuMs.toFixed(1)}ms`);
});
