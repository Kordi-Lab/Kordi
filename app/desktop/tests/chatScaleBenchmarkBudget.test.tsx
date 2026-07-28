import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CHAT_SCALE_BENCHMARK_BUDGETS,
  chatScaleBenchmarkBudgetFailures,
} from '../scripts/chat-scale-budget';

test('chat scale budgets tolerate ordinary host contention without hiding algorithmic regressions', () => {
  assert.deepEqual(
    {
      canonicalIndexMs: CHAT_SCALE_BENCHMARK_BUDGETS.canonicalIndexMs,
      cloudIndexDeltaMs: CHAT_SCALE_BENCHMARK_BUDGETS.cloudIndexDeltaMs,
    },
    {
      canonicalIndexMs: 160,
      cloudIndexDeltaMs: 80,
    },
  );

  assert.deepEqual(chatScaleBenchmarkBudgetFailures({
    collaborationMapMs: 1,
    canonicalIndexMs: 125,
    cloudIndexMs: 2_800,
    cloudIndexDeltaMs: 65,
    cloudDeliveryLookupMs: 0,
    serializedCacheBytes: 66_904_865,
  }), []);

  assert.deepEqual(chatScaleBenchmarkBudgetFailures({
    collaborationMapMs: 1,
    canonicalIndexMs: 250,
    cloudIndexMs: 5_000,
    cloudIndexDeltaMs: 500,
    cloudDeliveryLookupMs: 10,
    serializedCacheBytes: 80 * 1024 * 1024,
  }), [
    'canonicalIndexMs=250 exceeds 160',
    'cloudIndexMs=5000 exceeds 4000',
    'cloudIndexDeltaMs=500 exceeds 80',
    'cloudDeliveryLookupMs=10 exceeds 5',
    `serializedCacheBytes=${80 * 1024 * 1024} exceeds ${70 * 1024 * 1024}`,
  ]);
});
