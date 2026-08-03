import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cleanupVirtualTranscriptHarness,
  installVirtualTranscriptHarness,
  render,
  rows,
  transcript,
} from './support/virtualTranscriptHarness';

test.before(async () => {
  await installVirtualTranscriptHarness();
});

test.afterEach(async () => {
  await cleanupVirtualTranscriptHarness();
});

test('reply navigation waits for the mounted row highlight before acknowledging the request', async () => {
  let readyAttempts = 0;
  const handledRequests: Array<{ id: string; nonce: number; sessionKey: string }> = [];

  await render(transcript({
    items: rows('reply-', 0, 100),
    navigationRequest: { id: 'reply-10', nonce: 1 },
    onNavigationReady: () => {
      readyAttempts += 1;
      return readyAttempts >= 2;
    },
    onNavigationHandled: (request) => handledRequests.push(request),
  }));

  assert.equal(readyAttempts, 2);
  assert.deepEqual(handledRequests, [{
    id: 'reply-10',
    nonce: 1,
    sessionKey: 'session:one',
  }]);
});
