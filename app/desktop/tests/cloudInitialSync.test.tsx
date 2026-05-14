import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CLOUD_INITIAL_SYNC_TIMEOUT_MS, cloudInitialSyncStatus } from '../src/features/cloud/initialSync';

test('cloud initial sync waits for canonical fetch to settle', () => {
  assert.equal(cloudInitialSyncStatus({
    isCloudEdition: true,
    accountReady: true,
    canonicalSettled: false,
    canonicalReady: false,
    contactsSettled: true,
    messagesSettled: true,
    startedAtMs: 1_000,
    nowMs: 1_500,
  }), 'syncing');
});

test('cloud initial sync is ready for an empty session list after first sync attempts settle', () => {
  assert.equal(cloudInitialSyncStatus({
    isCloudEdition: true,
    accountReady: true,
    canonicalSettled: true,
    canonicalReady: true,
    contactsSettled: true,
    messagesSettled: true,
    startedAtMs: 1_000,
    nowMs: 1_700,
  }), 'ready');
});

test('cloud initial sync times out with retryable error state', () => {
  assert.equal(cloudInitialSyncStatus({
    isCloudEdition: true,
    accountReady: true,
    canonicalSettled: false,
    canonicalReady: false,
    contactsSettled: false,
    messagesSettled: false,
    startedAtMs: 1_000,
    nowMs: 1_000 + CLOUD_INITIAL_SYNC_TIMEOUT_MS + 1,
  }), 'error');
});

test('cloud initial sync waits for the app model cloud account to hydrate', () => {
  assert.equal(cloudInitialSyncStatus({
    isCloudEdition: true,
    accountReady: false,
    canonicalSettled: false,
    canonicalReady: false,
    contactsSettled: false,
    messagesSettled: false,
    startedAtMs: 1_000,
    nowMs: 1_500,
  }), 'syncing');
});

test('cloud initial sync does not gate local edition', () => {
  assert.equal(cloudInitialSyncStatus({
    isCloudEdition: false,
    accountReady: false,
    canonicalSettled: false,
    canonicalReady: false,
    contactsSettled: false,
    messagesSettled: false,
    startedAtMs: 1_000,
    nowMs: 1_000,
  }), 'ready');
});
