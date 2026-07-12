import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CloudProfileIdentityAdoptionCoordinator,
  CloudSyncCoordinator,
} from '../src/features/cloud/cloudSyncCoordinator';
import type {
  AdoptCloudProfileIdentityRequest,
  CanonicalProfileIdentityDelta,
} from '../src/kordi-app/types';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => { resolve = next; });
  return { promise, resolve };
}

function deferredValue<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function adoptionRequest(displayName: string): AdoptCloudProfileIdentityRequest {
  return {
    accountId: 'acct',
    displayName,
    avatarKey: 'acct',
    profileImageUrl: `https://example.invalid/${displayName}.png`,
  };
}

function adoptionDelta(
  displayName: string,
  previousIdentityId: string,
): CanonicalProfileIdentityDelta {
  return {
    profile: {
      id: 'profile:local',
      displayName,
      humanIdentityId: 'human:acct',
      activeAgentIdentityId: null,
      storageRoot: '/tmp',
      createdAtMs: 1,
      updatedAtMs: 2,
    },
    identity: {
      id: 'human:acct',
      kind: 'human',
      displayName,
      ownerIdentityId: null,
      source: 'local',
      sourceHostId: null,
      bridgeNodeId: null,
      humanId: 'acct',
      agentId: null,
      avatarKey: 'acct',
      profileImageUrl: `https://example.invalid/${displayName}.png`,
      metadata: { accountId: 'acct', cloudProfileIdentity: true },
      createdAtMs: 1,
      updatedAtMs: 2,
    },
    previousIdentityId,
    groupSelfSessionIds: [],
  };
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

test('Cloud profile adoption commits the migration delta before one newest trailing profile refresh', async () => {
  const coordinator = new CloudProfileIdentityAdoptionCoordinator();
  const first = deferredValue<CanonicalProfileIdentityDelta>();
  const calls: string[] = [];
  const commits: string[] = [];
  const adopt = async (request: AdoptCloudProfileIdentityRequest) => {
    calls.push(request.displayName);
    return request.displayName === 'A'
      ? first.promise
      : adoptionDelta(request.displayName, 'human:acct');
  };
  const commit = (delta: CanonicalProfileIdentityDelta) => {
    commits.push(`${delta.profile.displayName}:${delta.previousIdentityId}`);
  };

  const pending = coordinator.request(adoptionRequest('A'), adopt, commit);
  void coordinator.request(adoptionRequest('B'), adopt, commit);
  void coordinator.request(adoptionRequest('C'), adopt, commit);

  assert.deepEqual(calls, ['A']);
  first.resolve(adoptionDelta('A', 'human:legacy'));
  await pending;

  assert.deepEqual(calls, ['A', 'C']);
  assert.deepEqual(commits, ['A:human:legacy', 'C:human:acct']);
});

test('Cloud profile adoption invalidates an old account result before running the new account request', async () => {
  const coordinator = new CloudProfileIdentityAdoptionCoordinator();
  const first = deferredValue<CanonicalProfileIdentityDelta>();
  const calls: string[] = [];
  const commits: string[] = [];
  const adopt = async (request: AdoptCloudProfileIdentityRequest) => {
    calls.push(request.displayName);
    return request.displayName === 'Old account'
      ? first.promise
      : adoptionDelta(request.displayName, 'human:new');
  };
  const commit = (delta: CanonicalProfileIdentityDelta) => {
    commits.push(delta.profile.displayName ?? '');
  };

  const pending = coordinator.request(adoptionRequest('Old account'), adopt, commit);
  coordinator.changeAccount();
  void coordinator.request(adoptionRequest('New account'), adopt, commit);

  assert.deepEqual(calls, ['Old account']);
  first.resolve(adoptionDelta('Old account', 'human:legacy'));
  await pending;

  assert.deepEqual(calls, ['Old account', 'New account']);
  assert.deepEqual(commits, ['New account']);
});
