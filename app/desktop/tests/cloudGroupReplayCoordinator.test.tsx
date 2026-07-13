import assert from 'node:assert/strict';
import test from 'node:test';

import { CloudGroupReplayCoordinator } from '../src/features/cloud/cloudGroupReplayCoordinator';

type Row = { id: string };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => { resolve = next; });
  return { promise, resolve };
}

function flushMicrotasks() {
  return new Promise<void>((resolve) => queueMicrotask(resolve));
}

test('CloudGroupReplayCoordinator drains rows serially and deduplicates successes', async () => {
  const gate = deferred();
  const started: string[] = [];
  const completed: string[] = [];
  let inFlight = 0;
  let peakInFlight = 0;
  const coordinator = new CloudGroupReplayCoordinator<Row>();
  coordinator.changeAccount('acct:one');

  const firstDrain = coordinator.request({
    entries: [
      { key: 'one', row: { id: 'one' } },
      { key: 'two', row: { id: 'two' } },
    ],
    apply: async (row) => {
      started.push(row.id);
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      if (row.id === 'one') await gate.promise;
      completed.push(row.id);
      inFlight -= 1;
    },
  });

  await flushMicrotasks();
  assert.deepEqual(started, ['one']);
  gate.resolve();
  await firstDrain;
  assert.deepEqual(completed, ['one', 'two']);
  assert.equal(peakInFlight, 1);

  await coordinator.request({
    entries: [
      { key: 'one', row: { id: 'one' } },
      { key: 'two', row: { id: 'two' } },
    ],
    apply: async (row) => { started.push(`duplicate:${row.id}`); },
  });
  assert.deepEqual(started, ['one', 'two']);
  coordinator.dispose();
});

test('CloudGroupReplayCoordinator backs off failures and retries after cooldown', async () => {
  let nowMs = 10_000;
  let scheduled: (() => void) | null = null;
  const delays: number[] = [];
  const attempts: number[] = [];
  const failures: Array<{ attempt: number; retryDelayMs: number }> = [];
  const coordinator = new CloudGroupReplayCoordinator<Row>({
    now: () => nowMs,
    setTimer: (callback, delayMs) => {
      scheduled = callback;
      delays.push(delayMs);
      return delays.length;
    },
    clearTimer: () => { scheduled = null; },
  });
  coordinator.changeAccount('acct:one');

  const request = () => coordinator.request({
    entries: [{ key: 'broken', row: { id: 'broken' } }],
    apply: async () => {
      attempts.push(nowMs);
      throw new Error('expected failure');
    },
    onFailure: ({ attempt, retryDelayMs }) => failures.push({ attempt, retryDelayMs }),
  });

  await request();
  assert.deepEqual(attempts, [10_000]);
  assert.deepEqual(failures, [{ attempt: 1, retryDelayMs: 1_000 }]);
  assert.deepEqual(delays, [1_000]);

  await request();
  assert.deepEqual(attempts, [10_000], 'a render-time repeat must not bypass cooldown');

  nowMs = 11_000;
  const retry = scheduled;
  assert.ok(retry);
  retry();
  await flushMicrotasks();
  await flushMicrotasks();
  assert.deepEqual(attempts, [10_000, 11_000]);
  assert.deepEqual(failures, [
    { attempt: 1, retryDelayMs: 1_000 },
    { attempt: 2, retryDelayMs: 2_000 },
  ]);
  coordinator.dispose();
});

test('CloudGroupReplayCoordinator consumes a newer snapshot after the active drain', async () => {
  const gate = deferred();
  const applied: string[] = [];
  const coordinator = new CloudGroupReplayCoordinator<Row>();
  coordinator.changeAccount('acct:one');

  const active = coordinator.request({
    entries: [{ key: 'one', row: { id: 'one' } }],
    apply: async (row) => {
      applied.push(row.id);
      await gate.promise;
    },
  });
  await flushMicrotasks();
  const queued = coordinator.request({
    entries: [
      { key: 'one', row: { id: 'one' } },
      { key: 'two', row: { id: 'two' } },
    ],
    apply: async (row) => { applied.push(row.id); },
  });
  gate.resolve();
  await Promise.all([active, queued]);
  assert.deepEqual(applied, ['one', 'two']);
  coordinator.dispose();
});

test('CloudGroupReplayCoordinator invalidates queued rows when the account changes', async () => {
  const gate = deferred();
  const applied: string[] = [];
  const coordinator = new CloudGroupReplayCoordinator<Row>();
  coordinator.changeAccount('acct:one');

  const oldDrain = coordinator.request({
    entries: [
      { key: 'old-one', row: { id: 'old-one' } },
      { key: 'old-two', row: { id: 'old-two' } },
    ],
    apply: async (row) => {
      applied.push(row.id);
      if (row.id === 'old-one') await gate.promise;
    },
  });
  await flushMicrotasks();
  coordinator.changeAccount('acct:two');
  const newDrain = coordinator.request({
    entries: [{ key: 'new-one', row: { id: 'new-one' } }],
    apply: async (row) => { applied.push(row.id); },
  });
  gate.resolve();
  await Promise.all([oldDrain, newDrain]);
  assert.deepEqual(applied, ['old-one', 'new-one']);
  coordinator.dispose();
});
