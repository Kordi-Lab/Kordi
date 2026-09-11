import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCloudHistoryRepair } from '../src/features/cloud/cloudHistoryRepair';

test('idle syncs reuse successful history coverage until new data or a bootstrap invalidates it', async () => {
  const history = createCloudHistoryRepair();
  let scans = 0;
  const repair = async () => { scans += 1; };
  await history.run(repair);
  for (let poll = 0; poll < 100; poll += 1) assert.equal(history.run(repair), null);
  assert.equal(scans, 1);
  history.invalidate();
  await history.run(repair);
  assert.equal(scans, 2);
});

test('failed history repair is retried without waiting for another server event', async () => {
  const history = createCloudHistoryRepair();
  await assert.rejects(history.run(async () => { throw new Error('Offline'); })!, /Offline/);
  let repaired = false;
  await history.run(async () => { repaired = true; });
  assert.equal(repaired, true);
});

test('syncs share in-flight history repair and changes during it require a subsequent pass', async () => {
  const history = createCloudHistoryRepair();
  let finish!: () => void;
  const repair = () => new Promise<void>((resolve) => { finish = resolve; });
  const pending = history.run(repair);
  assert.equal(history.run(repair), pending);
  history.invalidate();
  await Promise.resolve();
  finish();
  await pending;
  let rescanned = false;
  await history.run(async () => { rescanned = true; });
  assert.equal(rescanned, true);
  assert.equal(history.run(repair), null);
  assert.notEqual(createCloudHistoryRepair().run(async () => {}), null, 'new accounts begin cold');
});
