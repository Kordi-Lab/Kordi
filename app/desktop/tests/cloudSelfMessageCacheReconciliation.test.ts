import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CloudMessage } from '../src/features/cloud/authClient';
import { encodeCloudAgentResponse } from '../src/features/cloud/cloudAgentMessages';
import { mergeCloudMessagesByPeerSnapshot } from '../src/features/cloud/cloudMessageSyncState';

const accountId = 'acct_me';
const selfMessage = (
  messageId: string,
  body = 'create a task',
  createdAt = '2026-05-11T09:59:00Z',
): CloudMessage => ({
  messageId,
  fromAccountId: accountId,
  toAccountId: accountId,
  direction: 'outgoing',
  body,
  createdAt,
  deliveredAt: createdAt,
  readAt: createdAt,
  sessionId: 'session:self-agent:one',
});

test('authoritative self snapshots prune stale cached replay rows but keep newer local work', () => {
  const keeper = selfMessage('msg_keeper');
  const duplicateRows = Array.from({ length: 20_000 }, (_, index) => ({
    ...keeper,
    messageId: `msg_duplicate_${index}`,
  }));
  const localNewer = selfMessage(
    'msg_local_newer',
    'new local message',
    '2026-05-11T10:01:00Z',
  );

  const startedAt = performance.now();
  const merged = mergeCloudMessagesByPeerSnapshot(
    { [accountId]: [...duplicateRows, localNewer] },
    { [accountId]: [keeper] },
    { authoritativeSelfAccountId: accountId },
  );
  const durationMs = performance.now() - startedAt;

  assert.deepEqual(
    merged[accountId]?.map((item) => item.messageId),
    ['msg_keeper', 'msg_local_newer'],
  );
  assert.ok(durationMs < 1_000, `cache cleanup took ${durationMs}ms`);
});

test('self snapshot cache cleanup preserves referenced requests and attachments', () => {
  const referenced = selfMessage('msg_referenced', 'same request');
  const attachment = {
    ...selfMessage('msg_attachment', 'same request'),
    attachments: [{
      attachmentId: 'att_1',
      name: 'brief.pdf',
      kind: 'file' as const,
      mimeType: 'application/pdf',
      sizeBytes: 1_024,
    }],
  };
  const response = selfMessage(
    'msg_response',
    encodeCloudAgentResponse({
      requestId: referenced.messageId,
      text: 'done',
      deliveryState: 'complete',
    }),
    '2026-05-11T10:00:00Z',
  );

  const merged = mergeCloudMessagesByPeerSnapshot(
    {
      [accountId]: [
        selfMessage('msg_unreferenced_duplicate', 'same request'),
        referenced,
        attachment,
      ],
    },
    { [accountId]: [response] },
    { authoritativeSelfAccountId: accountId },
  );

  assert.deepEqual(
    merged[accountId]?.map((item) => item.messageId),
    ['msg_referenced', 'msg_attachment', 'msg_response'],
  );
});
