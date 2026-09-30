import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SetStateAction } from 'react';

import {
  markLocalAgentMessageDelivered,
  startLocalAgentTurn,
  type LocalAgentTurnContext,
} from '../src/features/chat/messageActions/localAgentTurnDispatch';
import { prepareCanonicalQueuedMessage, prepareCanonicalUserMessage } from '../src/features/chat/messageActions/optimistic';
import { planCloudSelfAgentSync } from '../src/features/cloud/cloudSelfAgentForwardSync';
import type { CanonicalSessionState } from '../src/kordi-app/types';

const route = {
  model: 'openai-codex/gpt-5.5',
  authProvider: 'openai-codex',
  authChoice: 'cloud-login:saved',
  thinking: 'medium',
};

function hostedSend() {
  const prepared = prepareCanonicalUserMessage(
    'session-1', 'human:me', 'hello', [], '12:31', 'desktop-chat-ui',
  );
  assert.ok(prepared);
  let state: CanonicalSessionState | null = {
    sessions: [{ id: 'session-1', updatedAtMs: 1, lastMessageAtMs: 1 }],
    messages: [{
      id: prepared.messageId,
      sessionId: 'session-1',
      status: 'sending',
      updatedAtMs: 1,
      content: { sender: 'Me', timeLabel: '12:31' },
    }],
  } as unknown as CanonicalSessionState;
  const errors: Array<string | null> = [];
  const context = {
    canonicalSessionId: 'session-1',
    route,
    setCanonicalSessionState: (update: SetStateAction<CanonicalSessionState | null>) => {
      state = typeof update === 'function' ? update(state) : update;
    },
    setDesktopChatError: (error: string | null) => { errors.push(error); },
  } as LocalAgentTurnContext;
  return { prepared, context, currentState: () => state, errors };
}

test('hosted delivery makes the exact route visible before forward sync can plan the sent message', async () => {
  const send = hostedSend();
  let persistedContent: unknown;
  await markLocalAgentMessageDelivered(send.context, send.prepared, async (request) => {
    assert.equal(send.currentState()?.messages[0]?.status, 'sending', 'forwarding waits for the durable write');
    persistedContent = request.content;
  });
  const message = send.currentState()?.messages[0];
  assert.equal(message?.status, 'sent');
  assert.deepEqual((message?.content as { agentRuntimeRoute?: unknown }).agentRuntimeRoute, route);
  assert.deepEqual((persistedContent as { agentRuntimeRoute?: unknown }).agentRuntimeRoute, route);
  assert.deepEqual(send.errors, []);
});

test('a failed hosted delivery or missing canonical identity cannot silently finish a turn', async () => {
  const send = hostedSend();
  await assert.rejects(
    markLocalAgentMessageDelivered(send.context, send.prepared, async () => { throw new Error('write failed'); }),
    /write failed/,
  );
  assert.equal(send.currentState()?.messages[0]?.status, 'sending');
  assert.deepEqual(send.errors, ['write failed']);
  await assert.rejects(startLocalAgentTurn(send.context, null, []), /identity is ready/);
});

test('hosted queued delivery clears queue state before forwarding its single request', async () => {
  const queued = {
    id: 'queued-local-chat:session-1:synthetic', sessionId: 'session-1', scope: 'chat' as const,
    text: 'hello', time: '12:31', createdAtMs: 1000, attachments: [], runtimeRoute: route,
  };
  const pending = prepareCanonicalQueuedMessage(queued, 'human:me', 'queued')!;
  const sent = prepareCanonicalQueuedMessage(queued, 'human:me', 'sent')!;
  let state = {
    sessions: [{ id: 'session-1', kind: 'self-agent', status: 'active', updatedAtMs: 1 }],
    messages: [{ ...pending.request, sequenceNum: 1, updatedAtMs: 1000 }],
    identities: [], participants: [], profile: { humanIdentityId: 'human:me' },
  } as unknown as CanonicalSessionState;
  const context = {
    canonicalSessionId: queued.sessionId,
    route,
    setCanonicalSessionState: (update: SetStateAction<CanonicalSessionState | null>) => {
      state = (typeof update === 'function' ? update(state) : update)!;
    },
    setDesktopChatError: () => undefined,
  } as LocalAgentTurnContext;
  assert.deepEqual(planCloudSelfAgentSync(state, {}), []);
  await markLocalAgentMessageDelivered(context, sent, async (request) => {
    assert.equal((request.content as Record<string, unknown>).queueState, 'sent');
    assert.equal((request.content as Record<string, unknown>).agentRuntimeRoute, route);
  });
  assert.equal((state.messages[0].content as Record<string, unknown>).queueState, 'sent');
  const operations = planCloudSelfAgentSync(state, {});
  assert.equal(operations.length, 1);
  assert.deepEqual(operations[0].agentRuntimeRoute, route);
  assert.equal(operations[0].localMessageId, queued.id);
});
