import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CLOUD_INITIAL_SYNC_TIMEOUT_MS, canonicalStateHasCloudLocalBackup, cloudInitialSyncStatus } from '../src/features/cloud/initialSync';

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

test('cloud initial sync does not block the Cloud shell on the local agent runtime', () => {
  assert.equal(cloudInitialSyncStatus({
    isCloudEdition: true,
    accountReady: true,
    canonicalSettled: true,
    canonicalReady: true,
    localBackupReady: true,
    contactsSettled: true,
    messagesSettled: true,
    desktopChatSettled: false,
    startedAtMs: 1_000,
    nowMs: 1_500,
  }), 'ready');
});

test('cloud initial sync renders usable local state while network catch-up continues', () => {
  assert.equal(cloudInitialSyncStatus({
    isCloudEdition: true,
    accountReady: true,
    canonicalSettled: true,
    canonicalReady: true,
    contactsSettled: false,
    messagesSettled: false,
    desktopChatSettled: false,
    startedAtMs: 1_000,
    nowMs: 1_500,
  }), 'ready');
});

test('cloud initial sync can recover from canonical refresh failure using the v2 local backup', () => {
  assert.equal(cloudInitialSyncStatus({
    isCloudEdition: true,
    accountReady: true,
    canonicalSettled: true,
    canonicalReady: false,
    localBackupReady: true,
    contactsSettled: false,
    messagesSettled: false,
    desktopChatSettled: false,
    startedAtMs: 1_000,
    nowMs: 1_500,
  }), 'ready');
});

test('cloud initial sync opens from local backup while cloud diff sync continues', () => {
  assert.equal(cloudInitialSyncStatus({
    isCloudEdition: true,
    accountReady: true,
    canonicalSettled: true,
    canonicalReady: true,
    localBackupReady: true,
    contactsSettled: false,
    messagesSettled: false,
    startedAtMs: 1_000,
    nowMs: 1_500,
  }), 'ready');
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

test('cloud initial sync detects cached cloud messages as a local backup', () => {
  assert.equal(canonicalStateHasCloudLocalBackup({
    storagePath: '',
    profile: { id: 'profile', displayName: 'Me', humanIdentityId: 'human:me', agentIdentityId: 'agent:me', createdAtMs: 1, updatedAtMs: 1 },
    identities: [],
    sessions: [],
    participants: [],
    messages: [{
      id: 'msg:cached',
      sessionId: 'session:cached',
      senderIdentityId: 'human:peer',
      senderRole: 'person',
      messageKind: 'text',
      contentText: 'cached',
      status: 'delivered',
      sequenceNum: 1,
      createdAtMs: 1,
      updatedAtMs: 1,
      sourceTransport: 'cloud-group',
      sourceEventId: 'cloud-group:message-1',
    }],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  }, 'acct_me'), true);
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
