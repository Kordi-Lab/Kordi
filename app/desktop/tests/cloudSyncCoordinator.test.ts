import assert from 'node:assert/strict';
import test from 'node:test';

import { CloudSyncCoordinator } from '../src/features/cloud/cloudSyncCoordinator';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => { resolve = next; });
  return { promise, resolve };
}

test('CloudSyncCoordinator queues exactly one trailing run while a refresh is in flight', async () => {
  const coordinator = new CloudSyncCoordinator();
  const first = deferred();
  const calls: string[] = [];

  const firstRequest = coordinator.request(async () => {
    calls.push('A');
    await first.promise;
  });
  const secondRequest = coordinator.request(async () => {
    calls.push('B');
  });
  void coordinator.request(async () => {
    calls.push('C');
  });

  assert.deepEqual(calls, ['A']);
  first.resolve();
  await Promise.all([firstRequest, secondRequest]);
  assert.deepEqual(calls, ['A', 'C']);
});

test('CloudSyncCoordinator discards old-account commits and runs the newest generation', async () => {
  const coordinator = new CloudSyncCoordinator();
  const first = deferred();
  const commits: string[] = [];

  const request = coordinator.request(async (generation) => {
    await first.promise;
    if (coordinator.isCurrentGeneration(generation)) commits.push('old');
  });
  coordinator.changeAccount();
  void coordinator.request(async (generation) => {
    if (coordinator.isCurrentGeneration(generation)) commits.push('new');
  });

  first.resolve();
  await request;
  assert.deepEqual(commits, ['new']);
});
