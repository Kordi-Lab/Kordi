import assert from 'node:assert/strict';
import { test } from 'node:test';
import { persistCloudGroupAgentCancellation } from '../src/features/cloud/cloudGroupAgentRunState';
import type { AppendCanonicalMessageRequest } from '../src/kordi-app/types';

test('a cancelled native turn is persisted without assuming the owner pressed Stop', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const requests: AppendCanonicalMessageRequest[] = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    __TAURI_INTERNALS__: { invoke: async (command: string, args: { request: AppendCanonicalMessageRequest }) => {
      assert.equal(command, 'desktop_canonical_upsert_message_fast');
      requests.push(args.request);
      return args.request;
    } },
  } });
  try {
    await persistCloudGroupAgentCancellation({
      context: { account: { accountId: 'owner' }, envelope: { groupId: 'group', message: { id: 'request' } } },
      setCanonicalState: () => undefined,
    } as never, {
      id: 'processing-slot', sessionId: 'group', senderIdentityId: 'agent:owner', senderRole: 'owned-agent',
      content: {}, createdAtMs: 100,
    } as never, { status: 'cancelled', thinkingText: 'Synthetic reasoning', tools: [] } as never);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].contentText, 'Request stopped.');
    assert.equal(requests[0].status, 'cancelled');
    assert.equal(Object.hasOwn(requests[0].content, 'cancelledByAccountId'), false);
    assert.equal(Object.hasOwn(requests[0].content, 'cancelledByRole'), false);
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
