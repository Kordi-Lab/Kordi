import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CLOUD_PRESENCE_HEARTBEAT_MS,
  shouldPublishPresenceOfflineForEvent,
} from '../src/features/cloud/useCloudPresencePublisher';

test('presence heartbeat interval is conservative for tunnel previews', () => {
  assert.ok(CLOUD_PRESENCE_HEARTBEAT_MS >= 20_000);
});

test('presence offline publishes only for real page lifecycle events', () => {
  assert.equal(shouldPublishPresenceOfflineForEvent('pagehide'), true);
  assert.equal(shouldPublishPresenceOfflineForEvent('beforeunload'), true);
  assert.equal(shouldPublishPresenceOfflineForEvent('react-cleanup'), false);
});
