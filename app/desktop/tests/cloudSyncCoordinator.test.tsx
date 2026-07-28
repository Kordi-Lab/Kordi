import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CloudProfileIdentityAdoptionCoordinator,
  CloudSyncCoordinator,
} from '../src/features/cloud/cloudSyncCoordinator';
import { applyCanonicalProfileIdentityDelta } from '../src/features/canonical/canonicalStateReducers';
import type {
  AdoptCloudProfileIdentityRequest,
  CanonicalProfileIdentityDelta,
  CanonicalSessionState,
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

function adoptionRequest(
  displayName: string,
  accountId = 'acct',
): AdoptCloudProfileIdentityRequest {
  return {
    accountId,
    displayName,
    avatarKey: accountId,
    profileImageUrl: `https://example.invalid/${displayName}.png`,
  };
}

function adoptionDelta(
  displayName: string,
  previousIdentityId: string,
  identityId = 'human:acct',
  accountId = 'acct',
): CanonicalProfileIdentityDelta {
  return {
    profile: {
      id: 'profile:local',
      displayName,
      humanIdentityId: identityId,
      activeAgentIdentityId: null,
      storageRoot: '/tmp',
      createdAtMs: 1,
      updatedAtMs: 2,
    },
    identity: {
      id: identityId,
      kind: 'human',
      displayName,
      ownerIdentityId: null,
      source: 'local',
      sourceHostId: null,
      sourceIdentityId: null,
      humanId: accountId,
      agentId: null,
      avatarKey: accountId,
      profileImageUrl: `https://example.invalid/${displayName}.png`,
      metadata: { accountId, cloudProfileIdentity: true },
      createdAtMs: 1,
      updatedAtMs: 2,
    },
    previousIdentityId,
    groupSelfSessionIds: [],
  };
}

function canonicalState(identityId = 'human:legacy'): CanonicalSessionState {
  return {
    storagePath: '/tmp/canonical.sqlite3',
    profile: {
      id: 'profile:local',
      displayName: 'Legacy',
      humanIdentityId: identityId,
      activeAgentIdentityId: null,
      storageRoot: '/tmp',
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    identities: [],
    sessions: [{
      id: 'session:one',
      kind: 'group',
      title: 'One',
      status: 'active',
      createdByIdentityId: identityId,
      primaryIdentityId: identityId,
      relationshipIdentityId: identityId,
      metadata: null,
      createdAtMs: 1,
      updatedAtMs: 1,
      lastMessageAtMs: 1,
    }],
    participants: [{
      sessionId: 'session:one',
      identityId,
      role: 'self',
      state: 'active',
      addedByIdentityId: identityId,
      addedAtMs: 1,
      lastSeenAtMs: null,
      lastReadMessageId: null,
    }],
    messages: [{
      id: 'message:one',
      sessionId: 'session:one',
      senderIdentityId: identityId,
      senderRole: 'user',
      messageKind: 'text',
      contentText: 'hello',
      content: null,
      parentMessageId: null,
      delegatedExchangeId: null,
      status: 'sent',
      sequenceNum: 1,
      createdAtMs: 1,
      updatedAtMs: 1,
      contentHash: null,
      sourceTransport: 'desktop-chat-ui',
      sourceEventId: 'message:one',
    }],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  };
}

function assertLoadedIdentityReferences(
  state: CanonicalSessionState | null,
  identityId: string,
) {
  assert.ok(state);
  assert.equal(state.profile.humanIdentityId, identityId);
  assert.equal(state.sessions[0]?.createdByIdentityId, identityId);
  assert.equal(state.sessions[0]?.primaryIdentityId, identityId);
  assert.equal(state.sessions[0]?.relationshipIdentityId, identityId);
  assert.equal(state.participants[0]?.identityId, identityId);
  assert.equal(state.participants[0]?.addedByIdentityId, identityId);
  assert.equal(state.messages[0]?.senderIdentityId, identityId);
}

function hasPendingWork(coordinator: CloudProfileIdentityAdoptionCoordinator) {
  return (coordinator as unknown as { hasPendingWork?: () => boolean })
    .hasPendingWork?.call(coordinator) ?? false;
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

test('Cloud profile adoption dedupes identity-only rerenders while adopting same-account profile edits', async () => {
  const coordinator = new CloudProfileIdentityAdoptionCoordinator();
  const calls: AdoptCloudProfileIdentityRequest[] = [];
  const adopt = async (request: AdoptCloudProfileIdentityRequest) => {
    calls.push(request);
    return adoptionDelta(request.displayName, 'human:acct');
  };
  const initial = adoptionRequest('Initial');
  const renamed = adoptionRequest('Renamed');
  const newAvatar = {
    ...renamed,
    profileImageUrl: 'https://example.invalid/new-avatar.png',
  };

  await coordinator.request(initial, adopt, () => {});
  await coordinator.request(initial, adopt, () => {});
  await coordinator.request(renamed, adopt, () => {});
  await coordinator.request(renamed, adopt, () => {});
  await coordinator.request(newAvatar, adopt, () => {});

  assert.deepEqual(calls, [initial, renamed, newAvatar]);
});

test('Cloud profile adoption skips a queued same-generation signature that already succeeded', async () => {
  const coordinator = new CloudProfileIdentityAdoptionCoordinator();
  const first = deferredValue<CanonicalProfileIdentityDelta>();
  const calls: string[] = [];
  const commits: string[] = [];
  const adopt = async (request: AdoptCloudProfileIdentityRequest) => {
    calls.push(request.displayName);
    return calls.length === 1
      ? first.promise
      : adoptionDelta(request.displayName, 'human:acct');
  };
  const commit = (delta: CanonicalProfileIdentityDelta) => {
    commits.push(delta.profile.displayName ?? '');
  };

  const pending = coordinator.request(adoptionRequest('A'), adopt, commit);
  void coordinator.request(adoptionRequest('B'), adopt, commit);
  void coordinator.request(adoptionRequest('A'), adopt, commit);

  assert.deepEqual(calls, ['A']);
  first.resolve(adoptionDelta('A', 'human:legacy'));
  await pending;

  assert.deepEqual(calls, ['A']);
  assert.deepEqual(commits, ['A']);
});

test('Cloud profile adoption applies persisted account-switch deltas in native completion order', async () => {
  const coordinator = new CloudProfileIdentityAdoptionCoordinator();
  const first = deferredValue<CanonicalProfileIdentityDelta>();
  const second = deferredValue<CanonicalProfileIdentityDelta>();
  const secondStarted = deferred();
  const calls: string[] = [];
  const staleCommits: string[] = [];
  const commits: string[] = [];
  let rendererState: CanonicalSessionState | null = canonicalState();
  const accountADelta = adoptionDelta(
    'Account A',
    'human:legacy',
    'human:account-a',
    'account-a',
  );
  const accountBDelta = adoptionDelta(
    'Account B',
    'human:account-a',
    'human:account-b',
    'account-b',
  );
  const adopt = async (request: AdoptCloudProfileIdentityRequest) => {
    calls.push(request.displayName);
    if (request.accountId === 'account-a') return first.promise;
    secondStarted.resolve();
    return second.promise;
  };
  const staleCommit = (delta: CanonicalProfileIdentityDelta) => {
    staleCommits.push(`${delta.previousIdentityId}->${delta.identity.id}`);
  };
  const commit = (delta: CanonicalProfileIdentityDelta) => {
    commits.push(`${delta.previousIdentityId}->${delta.identity.id}`);
    rendererState = applyCanonicalProfileIdentityDelta(rendererState, delta);
  };

  const pending = coordinator.request(adoptionRequest('Account A', 'account-a'), adopt, staleCommit);
  coordinator.changeAccount();
  void coordinator.request(adoptionRequest('Account B', 'account-b'), adopt, commit);

  assert.deepEqual(calls, ['Account A']);
  first.resolve(accountADelta);
  await secondStarted.promise;

  assert.deepEqual(staleCommits, []);
  assert.deepEqual(commits, []);
  second.resolve(accountBDelta);
  await pending;

  assert.deepEqual(calls, ['Account A', 'Account B']);
  assert.deepEqual(staleCommits, []);
  assertLoadedIdentityReferences(rendererState, 'human:account-b');
  assert.deepEqual(commits, [
    'human:legacy->human:account-a',
    'human:account-a->human:account-b',
  ]);
});

test('Cloud profile adoption flushes a completed stale delta when the current account request fails', async () => {
  const coordinator = new CloudProfileIdentityAdoptionCoordinator();
  const first = deferredValue<CanonicalProfileIdentityDelta>();
  const currentError = new Error('account B adoption failed');
  const staleCommits: string[] = [];
  const commits: string[] = [];
  let rendererState: CanonicalSessionState | null = canonicalState();
  const accountADelta = adoptionDelta(
    'Account A',
    'human:legacy',
    'human:account-a',
    'account-a',
  );
  const adopt = async (request: AdoptCloudProfileIdentityRequest) => {
    if (request.accountId === 'account-a') return first.promise;
    throw currentError;
  };
  const staleCommit = (delta: CanonicalProfileIdentityDelta) => {
    staleCommits.push(`${delta.previousIdentityId}->${delta.identity.id}`);
  };
  const commit = (delta: CanonicalProfileIdentityDelta) => {
    commits.push(`${delta.previousIdentityId}->${delta.identity.id}`);
    rendererState = applyCanonicalProfileIdentityDelta(rendererState, delta);
  };

  const pending = coordinator.request(adoptionRequest('Account A', 'account-a'), adopt, staleCommit);
  coordinator.changeAccount();
  void coordinator.request(adoptionRequest('Account B', 'account-b'), adopt, commit);

  first.resolve(accountADelta);
  await assert.rejects(pending, currentError);

  assert.deepEqual(staleCommits, []);
  assertLoadedIdentityReferences(rendererState, 'human:account-a');
  assert.deepEqual(commits, ['human:legacy->human:account-a']);
});

test('Cloud profile adoption reconciles a rapid account A to B to A switch', async () => {
  const coordinator = new CloudProfileIdentityAdoptionCoordinator();
  const accountB = deferredValue<CanonicalProfileIdentityDelta>();
  const accountA = deferredValue<CanonicalProfileIdentityDelta>();
  const accountAStarted = deferred();
  const calls: string[] = [];
  const staleCommits: string[] = [];
  const commits: string[] = [];
  let nativeIdentityId = 'human:account-a';
  let rendererState: CanonicalSessionState | null = canonicalState('human:account-a');
  const accountBDelta = adoptionDelta(
    'Account B',
    'human:account-a',
    'human:account-b',
    'account-b',
  );
  const accountADelta = adoptionDelta(
    'Account A',
    'human:account-b',
    'human:account-a',
    'account-a',
  );
  const adopt = async (request: AdoptCloudProfileIdentityRequest) => {
    calls.push(request.displayName);
    if (request.accountId === 'account-b') {
      const delta = await accountB.promise;
      nativeIdentityId = delta.identity.id;
      return delta;
    }
    accountAStarted.resolve();
    const delta = await accountA.promise;
    nativeIdentityId = delta.identity.id;
    return delta;
  };
  const staleCommit = (delta: CanonicalProfileIdentityDelta) => {
    staleCommits.push(`${delta.previousIdentityId}->${delta.identity.id}`);
  };
  const commit = (delta: CanonicalProfileIdentityDelta) => {
    commits.push(`${delta.previousIdentityId}->${delta.identity.id}`);
    rendererState = applyCanonicalProfileIdentityDelta(rendererState, delta);
  };

  const pending = coordinator.request(adoptionRequest('Account B', 'account-b'), adopt, staleCommit);
  coordinator.changeAccount();
  const stableIdentityId = 'human:account-a';
  const pendingWhenRendererAlreadyStable = hasPendingWork(coordinator);
  if (
    rendererState.profile.humanIdentityId !== stableIdentityId
    || pendingWhenRendererAlreadyStable
  ) {
    void coordinator.request(adoptionRequest('Account A', 'account-a'), adopt, commit);
  }

  accountB.resolve(accountBDelta);
  if (pendingWhenRendererAlreadyStable) {
    await accountAStarted.promise;
    assert.deepEqual(staleCommits, []);
    assert.deepEqual(commits, []);
    accountA.resolve(accountADelta);
  }
  await pending;

  assert.equal(nativeIdentityId, 'human:account-a');
  assert.equal(pendingWhenRendererAlreadyStable, true);
  assert.deepEqual(calls, ['Account B', 'Account A']);
  assert.deepEqual(staleCommits, []);
  assertLoadedIdentityReferences(rendererState, 'human:account-a');
  assert.deepEqual(commits, [
    'human:account-a->human:account-b',
    'human:account-b->human:account-a',
  ]);
});

test('Cloud profile adoption reports pending work through stale buffering and reconciliation', async () => {
  const coordinator = new CloudProfileIdentityAdoptionCoordinator();
  const accountB = deferredValue<CanonicalProfileIdentityDelta>();
  const staleCommits: string[] = [];
  const commits: string[] = [];
  const accountBDelta = adoptionDelta(
    'Account B',
    'human:account-a',
    'human:account-b',
    'account-b',
  );
  const accountADelta = adoptionDelta(
    'Account A',
    'human:account-b',
    'human:account-a',
    'account-a',
  );

  assert.equal(hasPendingWork(coordinator), false);
  const staleRequest = coordinator.request(
    adoptionRequest('Account B', 'account-b'),
    async () => accountB.promise,
    (delta) => staleCommits.push(delta.identity.id),
  );
  assert.equal(hasPendingWork(coordinator), true);

  coordinator.changeAccount();
  accountB.resolve(accountBDelta);
  await staleRequest;

  assert.deepEqual(staleCommits, []);
  assert.equal(hasPendingWork(coordinator), true);
  const reconciliation = coordinator.request(
    adoptionRequest('Account A', 'account-a'),
    async () => accountADelta,
    (delta) => commits.push(delta.identity.id),
  );
  assert.equal(hasPendingWork(coordinator), true);
  await reconciliation;

  assert.deepEqual(commits, ['human:account-b', 'human:account-a']);
  assert.equal(hasPendingWork(coordinator), false);
});

test('Cloud profile adoption clears pending work after a current failure flushes stale deltas', async () => {
  const coordinator = new CloudProfileIdentityAdoptionCoordinator();
  const accountB = deferredValue<CanonicalProfileIdentityDelta>();
  const currentError = new Error('account A reconciliation failed');
  const commits: string[] = [];
  const accountBDelta = adoptionDelta(
    'Account B',
    'human:account-a',
    'human:account-b',
    'account-b',
  );

  const staleRequest = coordinator.request(
    adoptionRequest('Account B', 'account-b'),
    async () => accountB.promise,
    () => assert.fail('a stale generation must not commit'),
  );
  coordinator.changeAccount();
  accountB.resolve(accountBDelta);
  await staleRequest;
  assert.equal(hasPendingWork(coordinator), true);

  const reconciliation = coordinator.request(
    adoptionRequest('Account A', 'account-a'),
    async () => { throw currentError; },
    (delta) => commits.push(delta.identity.id),
  );
  assert.equal(hasPendingWork(coordinator), true);
  await assert.rejects(reconciliation, currentError);

  assert.deepEqual(commits, ['human:account-b']);
  assert.equal(hasPendingWork(coordinator), false);
});
