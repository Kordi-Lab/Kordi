import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test('desktop chat transport contains no retired v1 message or sync endpoints', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const source = [
    'src/features/cloud/authClient.ts',
    'src/features/cloud/chatSyncV2ConversationClient.ts',
    'src/features/cloud/chatSyncV2SyncClient.ts',
    'src/features/cloud/useCloudRealtimeMessages.ts',
  ].map((path) => readFileSync(`${root}/${path}`, 'utf8')).join('\n');
  for (const retired of [
    '/v1/cloud/messages',
    '/v1/cloud/messages/read',
    '/v1/cloud/sync',
  ]) {
    assert.equal(source.includes(retired), false, `retired endpoint remains: ${retired}`);
  }
  for (const required of [
    '/v2/chat/conversations',
    '/v2/chat/sync',
    '/v2/chat/sync/bootstrap',
    '/v2/chat/realtime/ticket',
  ]) {
    assert.equal(source.includes(required), true, `v2 endpoint missing: ${required}`);
  }
});
