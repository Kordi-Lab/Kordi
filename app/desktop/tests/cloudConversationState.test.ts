import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mergeCloudConversationSnapshot } from '../src/features/cloud/useCloudConversation';
import type { CloudMessage } from '../src/features/cloud/authClient';

function message(id: string, createdAt: string, overrides: Partial<CloudMessage> = {}): CloudMessage {
  return {
    messageId: id,
    fromAccountId: 'acct_me',
    toAccountId: 'acct_me',
    body: id,
    createdAt,
    deliveredAt: null,
    readAt: null,
    direction: 'outgoing',
    sessionId: 'session:self-agent:test',
    attachments: [],
    ...overrides,
  };
}

test('Cloud conversation polling cannot erase a newer WebSocket Agent reply', () => {
  const request = message('msg:request', '2026-07-15T06:00:00.000Z');
  const response = message('msg:response', '2026-07-15T06:00:01.000Z', {
    body: 'Agent response',
  });

  const merged = mergeCloudConversationSnapshot([request, response], [request]);

  assert.deepEqual(merged.map((item) => item.messageId), ['msg:request', 'msg:response']);
});

test('Cloud conversation snapshots update server fields while preserving an uploaded local attachment path', () => {
  const current = message('msg:image', '2026-07-15T06:00:00.000Z', {
    attachments: [{
      attachmentId: 'attachment:1',
      name: 'image.png',
      kind: 'image',
      mimeType: 'image/png',
      sizeBytes: 10,
      localPath: '/tmp/image.png',
    }],
  });
  const refreshed = message('msg:image', '2026-07-15T06:00:00.000Z', {
    deliveredAt: '2026-07-15T06:00:02.000Z',
    attachments: [{
      attachmentId: 'attachment:1',
      name: 'image.png',
      kind: 'image',
      mimeType: 'image/png',
      sizeBytes: 10,
      localPath: null,
    }],
  });

  const [merged] = mergeCloudConversationSnapshot([current], [refreshed]);

  assert.equal(merged?.deliveredAt, refreshed.deliveredAt);
  assert.equal(merged?.attachments?.[0]?.localPath, '/tmp/image.png');
});
