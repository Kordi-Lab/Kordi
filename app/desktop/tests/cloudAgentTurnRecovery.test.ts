import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CanonicalSessionMessage } from '../src/kordi-app/types';
import {
  CLOUD_AGENT_INTERRUPTED_TURN_NOTICE,
  interruptedCloudGroupAgentTurnRecovery,
  interruptedCloudGroupAgentTurnRecoveries,
} from '../src/features/cloud/useCloudAgentTurnRecovery';

function turn(
  state: 'queued' | 'processing' | 'complete',
  senderIdentityId = 'agent:cloud:acct_me',
): CanonicalSessionMessage {
  return {
    id: 'msg:stable-slot',
    sessionId: 'group:one',
    senderIdentityId,
    senderRole: 'owned-agent',
    messageKind: 'agent-turn',
    contentText: state === 'complete' ? 'Done' : `${state}...`,
    content: {
      sender: 'My Kordi',
      deliveryState: state,
      requestId: 'request:one',
    },
    status: state,
    sequenceNum: 1,
    createdAtMs: 1,
    updatedAtMs: 1,
    contentHash: null,
    sourceTransport: 'cloud-group-agent',
    sourceEventId: 'event:one',
  };
}

test('startup recovery terminates an interrupted processing slot in place', () => {
  const recovery = interruptedCloudGroupAgentTurnRecovery({
    message: turn('processing'),
    accountId: 'acct_me',
    now: 5_000,
  });

  assert.equal(recovery?.request.id, 'msg:stable-slot');
  assert.equal(recovery?.request.status, 'failed');
  assert.equal(recovery?.request.content.deliveryState, 'failed');
  assert.equal(
    recovery?.request.content.error,
    CLOUD_AGENT_INTERRUPTED_TURN_NOTICE,
  );
});

test('startup recovery also terminates queued work that lost its coordinator', () => {
  assert.equal(
    interruptedCloudGroupAgentTurnRecovery({
      message: turn('queued'),
      accountId: 'acct_me',
    })?.request.status,
    'failed',
  );
});

test('startup recovery ignores terminal and other-account turns', () => {
  assert.equal(interruptedCloudGroupAgentTurnRecovery({
    message: turn('complete'),
    accountId: 'acct_me',
  }), null);
  assert.equal(interruptedCloudGroupAgentTurnRecovery({
    message: turn('processing', 'agent:cloud:acct_peer'),
    accountId: 'acct_me',
  }), null);
});

test('startup recovery filters ordinary transcript history before lifecycle work', () => {
  const ordinaryHistory = Array.from({ length: 2_000 }, (_, index) => ({
    ...turn('complete'),
    id: `history:${index}`,
    messageKind: 'text',
    senderRole: 'user',
    sourceTransport: 'cloud-group-message',
  } satisfies CanonicalSessionMessage));
  const interrupted = turn('processing');

  const recoveries = interruptedCloudGroupAgentTurnRecoveries({
    messages: [...ordinaryHistory, interrupted],
    accountId: 'acct_me',
    now: 5_000,
  });

  assert.equal(recoveries.length, 1);
  assert.equal(recoveries[0]?.request.id, interrupted.id);
  assert.equal(ordinaryHistory[0]?.status, 'complete');
});
