import assert from 'node:assert/strict';
import test from 'node:test';
import { hostedRequestIsSettled, localChatSendDelayReason } from '../src/features/chat/messageActions/localChatQueue';
import type { CanonicalSessionState } from '../src/kordi-app/types';

const sessionId = 'synthetic-hosted-chat';

function stateWith(messages: Array<Record<string, unknown>>) {
  return { messages: messages.map(message => ({ sessionId, content: null, parentMessageId: null, ...message })) } as unknown as CanonicalSessionState;
}

function reply(status: string, link: 'parent' | 'content' = 'parent') {
  return {
    id: `reply:${status}`, senderRole: 'owned-agent', messageKind: 'agent-turn', status,
    parentMessageId: link === 'parent' ? 'request-1' : null,
    content: { deliveryState: status, ...(link === 'content' ? { requestId: 'request-1' } : {}) },
  };
}

test('a running hosted request delays a send to its session', () => {
  assert.equal(localChatSendDelayReason({ inFlight: null, targetSessionId: sessionId, desktopLiveTurn: null, hostedRequestRunning: true }), 'same-session-running');
  assert.equal(localChatSendDelayReason({ inFlight: null, targetSessionId: sessionId, desktopLiveTurn: null, hostedRequestRunning: false }), null);
  assert.equal(localChatSendDelayReason({ inFlight: null, targetSessionId: null, desktopLiveTurn: null, hostedRequestRunning: true }), null);
});

test('a hosted request settles only on a terminal reply or its own failure', () => {
  const request = { id: 'request-1', senderRole: 'user', messageKind: 'text', status: 'sent' };
  assert.equal(hostedRequestIsSettled(null, 'request-1'), false);
  assert.equal(hostedRequestIsSettled(stateWith([request]), 'request-1'), false);
  assert.equal(hostedRequestIsSettled(stateWith([request, reply('queued')]), 'request-1'), false);
  assert.equal(hostedRequestIsSettled(stateWith([request, reply('processing')]), 'request-1'), false);
  for (const status of ['complete', 'failed', 'cancelled']) {
    assert.equal(hostedRequestIsSettled(stateWith([request, reply(status)]), 'request-1'), true, status);
    assert.equal(hostedRequestIsSettled(stateWith([request, reply(status, 'content')]), 'request-1'), true, `${status} by request id`);
  }
  assert.equal(hostedRequestIsSettled(stateWith([{ ...request, status: 'failed' }]), 'request-1'), true);
  assert.equal(hostedRequestIsSettled(stateWith([request, { ...reply('complete'), parentMessageId: 'request-0' }]), 'request-1'), false);
});
