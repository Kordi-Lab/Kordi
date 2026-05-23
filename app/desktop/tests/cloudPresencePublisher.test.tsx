import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CLOUD_PRESENCE_HEARTBEAT_MS,
  shouldPublishPresenceOfflineForEvent,
} from '../src/features/cloud/useCloudPresencePublisher';

test('presence heartbeat interval keeps offline detection responsive', () => {
  assert.equal(CLOUD_PRESENCE_HEARTBEAT_MS, 10_000);
});

test('presence offline publishes only for real page lifecycle events', () => {
  assert.equal(shouldPublishPresenceOfflineForEvent('pagehide'), true);
  assert.equal(shouldPublishPresenceOfflineForEvent('beforeunload'), true);
  assert.equal(shouldPublishPresenceOfflineForEvent('react-cleanup'), false);
});
