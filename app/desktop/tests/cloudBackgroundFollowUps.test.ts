import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DesktopChatTurnSnapshot } from '../src/kordi-app/types';
import {
  cloudBackgroundFollowUpReply,
  publishCloudBackgroundFollowUp,
  registerCloudBackgroundFollowUpPublisher,
  type CloudBackgroundFollowUpReply,
} from '../src/features/cloud/cloudBackgroundFollowUps';

function followUpTurn(patch: Partial<DesktopChatTurnSnapshot> = {}): DesktopChatTurnSnapshot {
  return {
    id: 'follow-up-turn', sessionId: 'session:parent', prompt: 'Background session "Count lines" finished.',
    status: 'succeeded', message: 'Response complete', assistantText: 'The project has 1,204 lines.', thinkingText: '',
    tools: [], completed: true, succeeded: true,
    backgroundFollowUp: { id: 'background-result:child:done', sessionId: 'child', parentRequestId: 'request-1', title: 'Count lines', status: 'done' },
    ...patch,
  };
}

test('a follow-up reply is published once, under its own request id', async () => {
  const published: CloudBackgroundFollowUpReply[] = [];
  registerCloudBackgroundFollowUpPublisher('request-1', async (reply) => { published.push(reply); });

  assert.equal(await publishCloudBackgroundFollowUp(followUpTurn()), true);
  assert.equal(await publishCloudBackgroundFollowUp(followUpTurn()), false);
  assert.equal(published.length, 1);
  assert.equal(published[0]?.requestId, 'background-result:child:done');
  assert.equal(published[0]?.text, 'The project has 1,204 lines.');
  assert.equal(published[0]?.deliveryState, 'complete');
});

test('a running follow-up waits for its turn, and an unknown parent is left alone', async () => {
  const published: CloudBackgroundFollowUpReply[] = [];
  registerCloudBackgroundFollowUpPublisher('request-2', async (reply) => { published.push(reply); });
  const running = followUpTurn({
    id: 'running-turn', completed: false, succeeded: false, status: 'queued', assistantText: '',
    backgroundFollowUp: { id: 'background-result:child-2:failed', sessionId: 'child-2', parentRequestId: 'request-2', title: 'Count lines', status: 'failed' },
  });
  const finished = { ...running, completed: true, succeeded: false, status: 'failed', error: 'Provider unavailable' };

  assert.equal(await publishCloudBackgroundFollowUp(running, async () => finished), true);
  assert.equal(published[0]?.deliveryState, 'failed');
  assert.equal(published[0]?.text, 'Provider unavailable');

  const orphan = followUpTurn({ backgroundFollowUp: { id: 'background-result:other:done', sessionId: 'other', parentRequestId: 'unknown', title: 'Other', status: 'done' } });
  assert.equal(await publishCloudBackgroundFollowUp(orphan), false);
  assert.equal(cloudBackgroundFollowUpReply(followUpTurn({ backgroundFollowUp: null })), null);
});

test('a failed publish is retried on the next pass', async () => {
  let attempts = 0;
  registerCloudBackgroundFollowUpPublisher('request-3', async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('offline');
  });
  const turn = followUpTurn({ backgroundFollowUp: { id: 'background-result:child-3:stopped', sessionId: 'child-3', parentRequestId: 'request-3', title: 'Count lines', status: 'stopped' } });
  assert.equal(await publishCloudBackgroundFollowUp(turn), false);
  assert.equal(await publishCloudBackgroundFollowUp(turn), true);
  assert.equal(attempts, 2);
});
