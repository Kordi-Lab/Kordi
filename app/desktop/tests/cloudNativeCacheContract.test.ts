import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CloudMessage } from '../src/features/cloud/authClient';
import { cloudRecoveryMessagesReady } from '../src/features/cloud/cloudMessageSyncState';
import { cloudMessagesUseBrowserCache } from '../src/features/cloud/useCloudAccountLifecycleState';
import {
  compactNativeCloudMessagesByPeer,
  NATIVE_RENDERER_MESSAGE_LIMIT_PER_PEER,
} from '../src/features/cloud/useCloudCollaborationMessageStore';

test('native chat bypasses the legacy browser cache while web retains IndexedDB', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  try {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { __TAURI_INTERNALS__: {} },
    });
    assert.equal(cloudMessagesUseBrowserCache(), false);

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {},
    });
    assert.equal(cloudMessagesUseBrowserCache(), true);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'window', descriptor);
    else delete (globalThis as { window?: unknown }).window;
  }
});

test('durable native messages can start recovery before network catch-up', () => {
  assert.equal(cloudRecoveryMessagesReady(false, true, 1), true);
  assert.equal(cloudRecoveryMessagesReady(false, true, 0), false);
  assert.equal(cloudRecoveryMessagesReady(false, false, 1), false);
  assert.equal(cloudRecoveryMessagesReady(true, false, 0), true);
});

function message(
  index: number,
  overrides: Partial<CloudMessage> = {},
): CloudMessage {
  return {
    messageId: `message-${index}`,
    fromAccountId: 'acct_peer',
    toAccountId: 'acct_me',
    body: `Message ${index}`,
    createdAt: new Date(index * 1_000).toISOString(),
    deliveredAt: new Date(index * 1_000 + 1).toISOString(),
    readAt: null,
    direction: 'incoming',
    sessionId: 'session-one',
    ...overrides,
  };
}

test('native renderer compaction keeps tails, session heads, routes, and pending sends', () => {
  const messages = Array.from({ length: 80 }, (_, index) => message(index + 1));
  const sessionHead = message(1, { messageId: 'old-session-head', sessionId: 'session-two' });
  const route = message(2, { messageId: 'old-route', messageKind: 'agent-model-change' });
  const pending = message(3, {
    messageId: 'old-pending',
    deliveredAt: null,
    direction: 'outgoing',
  });
  const compacted = compactNativeCloudMessagesByPeer({
    acct_peer: [sessionHead, route, pending, ...messages.slice(3)],
  });
  const ids = new Set(compacted.acct_peer.map((item) => item.messageId));

  assert.equal(compacted.acct_peer.length, 67);
  assert.ok(ids.has('old-session-head'));
  assert.ok(ids.has('old-route'));
  assert.ok(ids.has('old-pending'));
  assert.ok(ids.has('message-80'));
  assert.equal(ids.has('message-4'), false);
});

test('native renderer compaction preserves an already bounded store by identity', () => {
  const store = { acct_peer: [message(1), message(2)] };
  assert.equal(compactNativeCloudMessagesByPeer(store), store);
});

test('native renderer compaction keeps the complete active session', () => {
  const active = Array.from({ length: 12 }, (_, index) => message(index + 1, {
    messageId: `active-${index + 1}`,
    sessionId: 'session-active',
  }));
  const recent = Array.from({ length: 80 }, (_, index) => message(index + 13));
  const compacted = compactNativeCloudMessagesByPeer(
    { acct_peer: [...active, ...recent] },
    NATIVE_RENDERER_MESSAGE_LIMIT_PER_PEER,
    'session-active',
  );

  assert.equal(compacted.acct_peer.length, 76);
  assert.deepEqual(
    compacted.acct_peer.filter((item) => item.sessionId === 'session-active'),
    active,
  );
});
