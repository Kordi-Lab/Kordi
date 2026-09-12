import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeCloudMessagesByPeerSnapshot } from '../src/features/cloud/cloudMessageSyncState';
import { buildScaleCloudMessagesByPeer } from './fixtures/chatScale';
import { createPropertyReadCounter } from './helpers/propertyReadCounter';

test('unchanged sync does not inspect 20,000 cached message bodies', () => {
  const counter = createPropertyReadCounter();
  const current = Object.fromEntries(Object.entries(buildScaleCloudMessagesByPeer())
    .map(([peer, messages]) => [peer, messages.map(counter.track)]));
  assert.equal(mergeCloudMessagesByPeerSnapshot(current, current), current);
  assert.equal(mergeCloudMessagesByPeerSnapshot(current, { ...current }), current);
  assert.equal(counter.count(), 0);
});

test('a changed peer does not inspect messages belonging to other peers', () => {
  const fixture = buildScaleCloudMessagesByPeer();
  const [changedPeer, ...otherPeers] = Object.keys(fixture);
  const counter = createPropertyReadCounter();
  const current = {
    ...Object.fromEntries(otherPeers.map((peer) => [peer, fixture[peer].map(counter.track)])),
    [changedPeer]: fixture[changedPeer],
  };
  const last = current[changedPeer].at(-1)!;
  const update = { ...last, body: 'Updated message' };
  const merged = mergeCloudMessagesByPeerSnapshot(current, {
    ...current,
    [changedPeer]: [update],
  });
  assert.equal(counter.count(), 0);
  assert.equal(merged[changedPeer].length, current[changedPeer].length);
  assert.equal(merged[changedPeer].at(-1)?.body, update.body);
  for (const peer of otherPeers) assert.equal(merged[peer], current[peer]);
});

test('deletion still removes the final message even when snapshots share references', () => {
  const message = Object.values(buildScaleCloudMessagesByPeer())[0][0];
  const current = { peer: [message] };
  assert.deepEqual(
    mergeCloudMessagesByPeerSnapshot(current, current, new Set([message.messageId])),
    {},
  );
  assert.deepEqual(
    mergeCloudMessagesByPeerSnapshot(current, {}, new Set([message.messageId])),
    {},
  );
  assert.equal(current.peer.length, 1);
});

test('tombstones block stale incoming messages without discarding unrelated cached rows', () => {
  const [first, second] = Object.values(buildScaleCloudMessagesByPeer())[0];
  const current = { peer: [first] };
  const deleted = new Set([second.messageId]);
  assert.equal(mergeCloudMessagesByPeerSnapshot(current, current, deleted), current);
  assert.equal(mergeCloudMessagesByPeerSnapshot(current, { peer: [second] }, deleted), current);
});
