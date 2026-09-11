import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCloudRepairPolling } from '../src/features/cloud/cloudRepairPolling';

test('healthy hidden windows make one repair request per minute; visible windows keep 15 seconds', async () => {
  for (const hidden of [true, false]) {
    let now = 0;
    let calls = 0;
    const polling = createCloudRepairPolling(() => now);
    polling.setRealtimeConnected(true);
    for (now = 15_000; now <= 60_000; now += 15_000) {
      await polling.poll(hidden, async () => { calls += 1; });
    }
    assert.equal(calls, hidden ? 1 : 4);
  }
});

test('hidden windows retain recovery polling when realtime is unavailable or disconnects', async () => {
  let now = 0;
  let calls = 0;
  const polling = createCloudRepairPolling(() => now);
  const sync = async () => { calls += 1; };
  now = 15_000;
  await polling.poll(true, sync);
  assert.equal(calls, 1);
  polling.setRealtimeConnected(true);
  now = 30_000;
  await polling.poll(true, sync);
  assert.equal(calls, 1);
  polling.setRealtimeConnected(false);
  now = 45_000;
  await polling.poll(true, sync);
  assert.equal(calls, 2);
});

test('foregrounding restores the normal cadence and a failed poll retries at the next tick', async () => {
  let now = 0;
  let calls = 0;
  const polling = createCloudRepairPolling(() => now);
  polling.setRealtimeConnected(true);
  now = 15_000;
  await polling.poll(true, async () => { calls += 1; });
  assert.equal(calls, 0);
  await polling.poll(false, async () => { calls += 1; throw new Error('Offline'); });
  now = 30_000;
  await polling.poll(true, async () => { calls += 1; });
  assert.equal(calls, 2);
});

test('slow repair requests cannot overlap', async () => {
  let now = 0;
  let calls = 0;
  let finish!: () => void;
  const polling = createCloudRepairPolling(() => now);
  now = 15_000;
  const pending = polling.poll(false, () => {
    calls += 1;
    return new Promise<void>((resolve) => { finish = resolve; });
  });
  now = 90_000;
  await polling.poll(false, async () => { calls += 1; });
  assert.equal(calls, 1);
  finish();
  await pending;
  await polling.poll(false, async () => { calls += 1; });
  assert.equal(calls, 2);
});
