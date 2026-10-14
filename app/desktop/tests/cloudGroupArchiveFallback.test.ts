import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CloudAuthClient } from '../src/features/cloud/authClient';
import { buildCloudAuthError } from '../src/features/cloud/cloudAuthError';
import {
  setCloudGroupArchived,
  type VisibilityMutationRunner,
} from '../src/features/cloud/useCloudGroupVisibilityActions';

const notAParticipant = () => buildCloudAuthError(
  403,
  { errorCode: 'not_a_participant', message: 'You can only update groups you participate in.' },
  'Could not archive cloud group.',
);

function harness(failure: unknown | null) {
  const ids = () => ({ current: new Set<string>() });
  const hiddenIdsRef = ids();
  const requests: boolean[] = [];
  const locallyArchived: string[][] = [];
  const client = {
    setCloudGroupSpaceArchived: async (_token: string, _groupSpaceId: string, archived: boolean) => {
      requests.push(archived);
      if (failure) throw failure;
    },
  } as unknown as CloudAuthClient;
  // The optimistic runner of the app: apply, commit, and roll back when the commit fails.
  const runMutation: VisibilityMutationRunner = async (_key, mutations, commit) => {
    const previous = mutations.map((mutation) => mutation.valueRef.current.has(mutation.id));
    const apply = (present: (index: number) => boolean) => mutations.forEach((mutation, index) => {
      if (present(index)) mutation.valueRef.current.add(mutation.id);
      else mutation.valueRef.current.delete(mutation.id);
    });
    apply((index) => mutations[index].present);
    try {
      await commit('token');
    } catch (error) {
      apply((index) => previous[index]);
      throw error;
    }
  };
  const run = (archived: boolean) => setCloudGroupArchived({
    client,
    runMutation,
    hiddenIdsRef,
    deletedIdsRef: ids(),
    pinnedIdsRef: ids(),
    pinnedGroupSpaceIdsRef: ids(),
    setHiddenIds: () => undefined,
    setDeletedIds: () => undefined,
    setPinnedIds: () => undefined,
    setPinnedGroupSpaceIds: () => undefined,
    groupSpaceId: 'group-space-1',
    sessionIds: ['session:group:one', ' session:group:two ', 'session:group:one'],
    archived,
    archiveLocally: async (sessionIds) => { locallyArchived.push(sessionIds); },
  });
  return { hiddenIdsRef, locallyArchived, requests, run };
}

test('archiving a group the server no longer lists for this account archives it locally', async () => {
  const error = notAParticipant();
  assert.equal(error.code, 'not_a_participant');
  assert.equal(error.status, 403);

  const stale = harness(error);
  await stale.run(true);
  assert.deepEqual(stale.requests, [true]);
  assert.deepEqual(stale.locallyArchived, [['session:group:one', 'session:group:two']]);
  assert.deepEqual([...stale.hiddenIdsRef.current], ['session:group:one', 'session:group:two'], 'the row stays hidden');
});

test('a group the server archives is not archived locally', async () => {
  const live = harness(null);
  await live.run(true);
  assert.deepEqual(live.requests, [true]);
  assert.deepEqual(live.locallyArchived, []);
});

test('other archive failures still surface and roll back', async () => {
  const failures = [
    buildCloudAuthError(403, { errorCode: 'not_a_group_member', message: 'Forbidden.' }, 'Could not archive cloud group.'),
    buildCloudAuthError(500, { errorCode: 'not_a_participant', message: 'Server error.' }, 'Could not archive cloud group.'),
    buildCloudAuthError(500, {}, 'Could not archive cloud group.'),
    new Error('Not signed in.'),
  ];
  for (const failure of failures) {
    const failing = harness(failure);
    await assert.rejects(failing.run(true), (error) => error === failure);
    assert.deepEqual(failing.locallyArchived, []);
    assert.equal(failing.hiddenIdsRef.current.size, 0);
  }
});

test('restoring a group never falls back to a local archive', async () => {
  const error = notAParticipant();
  const stale = harness(error);
  await assert.rejects(stale.run(false), (rejected) => rejected === error);
  assert.deepEqual(stale.locallyArchived, []);
});
