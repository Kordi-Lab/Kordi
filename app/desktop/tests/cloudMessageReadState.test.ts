import assert from 'node:assert/strict';
import test from 'node:test';

import type { CloudMessage } from '../src/features/cloud/authClient';
import { encodeCloudGroupControl } from '../src/features/cloud/cloudGroupMessages';
import { markCloudMessagesReadLocally } from '../src/features/cloud/cloudMessageSyncState';
import {
  CHAT_SYNC_LOCAL_STATE_CHANGED_EVENT,
  publishChatSyncLocalStateChanged,
} from '../src/lib/desktopChatSync';

const message: CloudMessage = {
  messageId: 'msg_1',
  fromAccountId: 'acct_peer',
  toAccountId: 'acct_me',
  body: 'hello from cloud',
  createdAt: '2026-05-11T10:00:00Z',
  deliveredAt: null,
  readAt: null,
  direction: 'incoming',
};

test('native chat commits publish an unread refresh event', () => {
  const target = new EventTarget();
  let events = 0;
  target.addEventListener(CHAT_SYNC_LOCAL_STATE_CHANGED_EVENT, () => { events += 1; });

  publishChatSyncLocalStateChanged(target);

  assert.equal(events, 1);
});

test('cloud group read marking patches stale local unread cache rows by session id', () => {
  const groupBody = encodeCloudGroupControl({
    kind: 'group-message',
    groupId: 'session:group:abc',
    groupSpaceId: 'session:group:abc',
    groupTitle: null,
    createdByAccountId: 'acct_me',
    actor: {
      accountId: 'acct_peer',
      displayName: 'Peer Person',
      avatarUrl: null,
      role: 'person',
    },
    participants: [],
    message: {
      id: 'msg:group-agent-final',
      senderAccountId: 'acct_peer',
      text: 'Hi 👋 How can I help?',
      createdAtMs: Date.parse('2026-05-11T10:00:00Z'),
      senderKind: 'agent',
      senderDisplayName: 'Kordi Project Driver',
    },
  });
  const staleGroupMessage: CloudMessage = {
    ...message,
    messageId: 'msg_group_final',
    body: groupBody,
    sessionId: 'session:group:abc',
  };
  const otherGroupMessage: CloudMessage = {
    ...staleGroupMessage,
    messageId: 'msg_other_group_unread',
    sessionId: 'session:group:other',
  };
  const directUnreadMessage: CloudMessage = {
    ...message,
    messageId: 'msg_direct_unread',
    sessionId: 'session:direct-person:acct_me:acct_peer',
  };

  const patched = markCloudMessagesReadLocally(
    { acct_peer: [staleGroupMessage, otherGroupMessage, directUnreadMessage] },
    'acct_me',
    { peerIds: ['acct_peer'], sessionIds: ['session:group:abc'] },
    '2026-05-11T10:01:00Z',
  );

  assert.equal(patched.acct_peer?.[0]?.readAt, '2026-05-11T10:01:00Z');
  assert.equal(patched.acct_peer?.[1]?.readAt, null);
  assert.equal(patched.acct_peer?.[2]?.readAt, null);
});
