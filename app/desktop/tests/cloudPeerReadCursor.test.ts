import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CloudMessage } from '../src/features/cloud/authClient';
import {
  mergeCloudPeerReadCursors,
  reconcileCloudPeerReadCursors,
} from '../src/features/cloud/cloudMessageSyncState';

const incomingMessage: CloudMessage = {
  messageId: 'msg_1',
  fromAccountId: 'acct_peer',
  toAccountId: 'acct_me',
  body: 'hello from cloud',
  createdAt: '2026-05-11T10:00:00Z',
  deliveredAt: null,
  readAt: null,
  direction: 'incoming',
};

test('peer read cursors reconcile stale cached messages outside the snapshot window', () => {
  const readCursor = '2026-05-11T10:30:00Z';
  const staleCachedMessage: CloudMessage = {
    ...incomingMessage,
    messageId: 'msg_cached_before_window',
    createdAt: '2026-05-11T09:00:00Z',
  };
  const newerUnreadMessage: CloudMessage = {
    ...incomingMessage,
    messageId: 'msg_after_cursor',
    createdAt: '2026-05-11T11:00:00Z',
  };
  const outgoingMessage: CloudMessage = {
    ...incomingMessage,
    messageId: 'msg_outgoing',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    direction: 'outgoing',
    createdAt: '2026-05-11T09:30:00Z',
  };
  const current = {
    acct_peer: [staleCachedMessage, outgoingMessage, newerUnreadMessage],
  };

  const reconciled = reconcileCloudPeerReadCursors(
    current,
    'acct_me',
    { acct_peer: readCursor },
  );

  assert.equal(reconciled.acct_peer?.[0]?.readAt, readCursor);
  assert.equal(reconciled.acct_peer?.[1], outgoingMessage);
  assert.equal(reconciled.acct_peer?.[2], newerUnreadMessage);
});

test('peer read cursor snapshots merge monotonically', () => {
  assert.deepEqual(
    mergeCloudPeerReadCursors(
      { acct_peer: '2026-05-11T10:30:00Z' },
      {
        acct_peer: '2026-05-11T10:00:00Z',
        acct_other: '2026-05-11T11:00:00Z',
      },
    ),
    {
      acct_other: '2026-05-11T11:00:00Z',
      acct_peer: '2026-05-11T10:30:00Z',
    },
  );
});

test('invalid peer cursors preserve the original message collection', () => {
  const current = { acct_peer: [incomingMessage] };

  assert.equal(
    reconcileCloudPeerReadCursors(current, 'acct_me', { acct_peer: 'invalid' }),
    current,
  );
});
