import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nearbyActivitySuggestions } from '../src/features/commonGround/nearbyActivities';
import { CgNearbyStore } from '../src/features/commonGround/storeNearby';
import { mockServer } from './helpers/commonGroundServer';

test('activity suggestions follow card kind and explicit camera or alumni icons', () => {
  assert.ok(nearbyActivitySuggestions({ kind: 'work', icon: null }).includes('Hiring'));
  assert.ok(!nearbyActivitySuggestions({ kind: 'health', icon: null }).includes('Hiring'));
  assert.ok(nearbyActivitySuggestions({ kind: 'custom', icon: 'leaf' }).includes('Training together'));
  assert.equal(nearbyActivitySuggestions({ kind: 'work', icon: 'camera' })[0], 'Photo walk');
  assert.equal(nearbyActivitySuggestions({ kind: 'custom', icon: 'graduation' })[0], 'Alumni meetup');
  assert.equal(nearbyActivitySuggestions({ kind: 'daily', icon: null })[0], 'Shared activity');
  assert.ok(!nearbyActivitySuggestions().includes('Hiring'));
});

test('a late activity edit from an old card cannot update the new card', async () => {
  const { client, calls } = mockServer({ 'GET nearby': { status: 200, body: { profileId: 'health', openTo: [] } } });
  const nearby = new CgNearbyStore({ client, open: () => undefined });
  await nearby.loadSettings();
  await nearby.setOpenTo(['Hiring'], 'work');
  assert.equal(calls.filter((call) => call.method === 'PUT').length, 0);
  assert.deepEqual(nearby.getSnapshot().settings?.openTo, []);
});
