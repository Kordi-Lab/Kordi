import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  resolveReplicatedGroupTitle,
  sharedGroupCustomTitle,
} from '../src/features/chat/groupTitle';

test('shared group title prefers the canonical root over session activity order', () => {
  assert.equal(sharedGroupCustomTitle([
    {
      sessionId: 'session:group:child',
      groupSpaceId: 'session:group:root',
      customName: 'Local stale name',
    },
    {
      sessionId: 'session:group:root',
      groupSpaceId: 'session:group:root',
      customName: 'Shared root name',
    },
  ], 'session:group:root'), 'Shared root name');
});

test('shared group title prefers the latest replicated rename over root position', () => {
  assert.equal(sharedGroupCustomTitle([
    {
      sessionId: 'session:group:root',
      groupSpaceId: 'session:group:root',
      customName: 'Old root name',
      groupNameUpdatedAtMs: 100,
    },
    {
      sessionId: 'session:group:child',
      groupSpaceId: 'session:group:root',
      customName: 'Replicated rename',
      groupNameUpdatedAtMs: 200,
    },
  ], 'session:group:root'), 'Replicated rename');
});

test('shared group title does not promote an unrevisioned local child fallback', () => {
  assert.equal(sharedGroupCustomTitle([
    {
      sessionId: 'session:group:root',
      groupSpaceId: 'session:group:root',
      customName: null,
    },
    {
      sessionId: 'session:group:child',
      groupSpaceId: 'session:group:root',
      customName: 'Different on every viewer',
    },
  ], 'session:group:root'), '');
});

test('replicated group title resolution rejects an older replayed label', () => {
  assert.deepEqual(resolveReplicatedGroupTitle({
    candidates: [{
      sessionId: 'session:group:root',
      groupSpaceId: 'session:group:root',
      customName: 'Current name',
      groupNameUpdatedAtMs: 200,
    }],
    groupSpaceId: 'session:group:root',
    incomingTitle: 'Stale replay',
    incomingUpdatedAtMs: 100,
  }), {
    title: 'Current name',
    updatedAtMs: 200,
    appliesIncoming: false,
  });
});

test('replicated group title resolution accepts a newer shared label', () => {
  assert.deepEqual(resolveReplicatedGroupTitle({
    candidates: [{
      sessionId: 'session:group:root',
      groupSpaceId: 'session:group:root',
      customName: 'Current name',
      groupNameUpdatedAtMs: 100,
    }],
    groupSpaceId: 'session:group:root',
    incomingTitle: 'New shared name',
    incomingUpdatedAtMs: 200,
  }), {
    title: 'New shared name',
    updatedAtMs: 200,
    appliesIncoming: true,
  });
});
