import assert from 'node:assert/strict';
import { test } from 'node:test';

import { collaborationUnreadMentionCount } from '../src/features/collaboration/unreadState';

test('unread structured person mentions exclude read and forwarded messages', () => {
  const mention = { label: 'Me', targetKind: 'person', targetIdentityId: 'human:acct_me', humanId: 'acct_me' };
  const mentionSource = { sourceSessionId: 'source', sourceMessageId: 'message', senderLabel: 'Peer', textPreview: '@Me quoted', attachmentCount: 0 };

  assert.equal(collaborationUnreadMentionCount({
    unreadCount: 2,
    identity: { localHumanId: 'acct_me' },
    messages: [
      { direction: 'inbound', mentions: [mention] },
      { direction: 'inbound', mentions: [mention], messageAction: { schemaVersion: 1, kind: 'forward', source: mentionSource } },
      { direction: 'inbound', mentions: [mention] },
    ],
  }), 1);
});
