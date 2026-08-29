import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { terminalCollaborationRetryFailure } from '../src/features/chat/messageActions/collaborationRetry';

test('direct video retry restarts native transfer and surfaces terminal failure', () => {
  const source = readFileSync(
    new URL('../src/features/chat/messageActions/collaborationRetry.ts', import.meta.url),
    'utf8',
  );
  assert.match(source, /attachments\.filter\(isMp4VideoAttachment\)/);
  assert.match(source, /uploadNativeCloudAttachment\(\{[\s\S]*path: attachment\.path/);

  const failure = terminalCollaborationRetryFailure({
    error: new Error('Video source is unavailable.'),
    conversationId: 'conversation-1',
    messageId: 'message-1',
  });
  assert.equal(failure.detail, 'Video source is unavailable.');
});
