import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SetStateAction } from 'react';

import {
  markLocalAgentMessageDelivered,
  type LocalAgentTurnContext,
} from '../src/features/chat/messageActions/localAgentTurnDispatch';
import { prepareCanonicalQueuedMessage } from '../src/features/chat/messageActions/optimistic';
import type { CloudMessage } from '../src/features/cloud/authClient';
import {
  boundedRequestContextMessages,
  MAX_REQUEST_CONTEXT_MESSAGES,
  MAX_REQUEST_CONTEXT_TEXT_CHARS,
} from '../src/features/cloud/cloudAgentRequestContext';
import {
  cloudDirectMessageContextMessages,
  encodeCloudDirectMessageEnvelope,
  parseCloudDirectMessageEnvelope,
} from '../src/features/cloud/cloudDirectMessages';
import { cloudSelfAgentExecutionContextMessages } from '../src/features/cloud/cloudSelfAgentExecutionContext';
import { publishCloudSelfAgentOperations } from '../src/features/cloud/cloudSelfAgentForwardExecution';
import { planCloudSelfAgentSync } from '../src/features/cloud/cloudSelfAgentForwardSync';
import type { CanonicalSessionState } from '../src/kordi-app/types';
import type { DesktopChatContextMessage } from '../src/lib/desktop';

const route = {
  model: 'openai-codex/gpt-5.5',
  authProvider: 'openai-codex',
  authChoice: 'cloud-login:saved',
  thinking: 'medium',
};

const reference: DesktopChatContextMessage = {
  id: 'ask-agent-reference:group-1',
  authorName: 'Current chat reference',
  authorKind: 'human',
  text: 'Reference: Current chat\nSession: Launch group\nRecent messages:\n- Ana: ship on Friday',
  createdAtMs: 1_000,
};
const identity: DesktopChatContextMessage = {
  id: 'runtime-identity', authorName: 'Kordi', authorKind: 'agent', text: '{}', contextRole: 'runtimeIdentity',
};
const resource: DesktopChatContextMessage = {
  id: 'group-directory', authorName: 'Kordi', authorKind: 'agent', text: 'all members', contextRole: 'resource',
};

async function deliverHostedRequest(contextMessages: DesktopChatContextMessage[]) {
  const queued = {
    id: 'queued-local-chat:session-1:ask', sessionId: 'session-1', scope: 'chat' as const,
    text: 'what did we decide?', time: '12:31', createdAtMs: 1000, attachments: [], runtimeRoute: route,
    contextMessages,
  };
  const pending = prepareCanonicalQueuedMessage(queued, 'human:me', 'queued')!;
  const sent = prepareCanonicalQueuedMessage(queued, 'human:me', 'sent')!;
  let state = {
    sessions: [{ id: 'session-1', kind: 'self-agent', status: 'active', updatedAtMs: 1 }],
    messages: [{ ...pending.request, sequenceNum: 1, updatedAtMs: 1000 }],
    identities: [], participants: [], profile: { humanIdentityId: 'human:me' },
  } as unknown as CanonicalSessionState;
  let persisted: Record<string, unknown> = {};
  const context = {
    canonicalSessionId: queued.sessionId,
    route,
    contextMessages,
    setCanonicalSessionState: (update: SetStateAction<CanonicalSessionState | null>) => {
      state = (typeof update === 'function' ? update(state) : update)!;
    },
    setDesktopChatError: () => undefined,
  } as LocalAgentTurnContext;
  await markLocalAgentMessageDelivered(context, sent, async (request) => {
    persisted = request.content as Record<string, unknown>;
  });
  return { state, persisted };
}

function recordingClient() {
  const bodies: string[] = [];
  return {
    bodies,
    async sendMessage(_token: string, accountId: string, body: string): Promise<CloudMessage> {
      bodies.push(body);
      return {
        messageId: `cloud-${bodies.length}`, fromAccountId: accountId, toAccountId: accountId, body,
        sessionId: 'session-1', createdAt: new Date(0).toISOString(), deliveredAt: null, readAt: null,
      };
    },
  };
}

test('reference context bounds keep only well-formed history-role entries', () => {
  const many = Array.from({ length: 10 }, (_, index) => ({ ...reference, id: `ref-${index}` }));
  assert.equal(boundedRequestContextMessages(many).length, MAX_REQUEST_CONTEXT_MESSAGES);
  const long = boundedRequestContextMessages([{ ...reference, text: 'x'.repeat(10_000) }]);
  assert.equal(long[0].text.length, MAX_REQUEST_CONTEXT_TEXT_CHARS);
  assert.deepEqual(boundedRequestContextMessages([
    identity, resource,
    { ...reference, contextRole: 'system' },
    { ...reference, id: 'requester:me' },
    { ...reference, id: ' ' },
    { ...reference, authorName: '' },
    'not a message',
  ]), []);
  assert.deepEqual(boundedRequestContextMessages(null), []);
});

test('a hosted Ask Agent send stores, forwards and executes its reference context', async () => {
  const { state, persisted } = await deliverHostedRequest([reference, identity, resource]);
  assert.deepEqual(persisted.agentContextMessages, [reference]);
  assert.deepEqual(persisted.agentRuntimeRoute, route, 'route handling is unchanged');
  assert.deepEqual((state.messages[0].content as Record<string, unknown>).agentContextMessages, [reference]);

  const operations = planCloudSelfAgentSync(state, {});
  assert.equal(operations.length, 1);
  assert.deepEqual(operations[0].contextMessages, [reference]);

  const client = recordingClient();
  await publishCloudSelfAgentOperations({
    accountId: 'acct-me', client, ledger: {}, mergeMessage: () => undefined, operations,
    saveLedger: () => undefined, token: 'token', uploadAttachments: async () => [],
  });
  const requestBody = client.bodies[0];
  assert.deepEqual(parseCloudDirectMessageEnvelope(requestBody)?.contextMessages, [reference]);
  assert.deepEqual(cloudDirectMessageContextMessages(requestBody), [reference]);

  const requestMessage: CloudMessage = {
    messageId: 'cloud-1', fromAccountId: 'acct-me', toAccountId: 'acct-me', body: requestBody,
    sessionId: 'session-1', createdAt: new Date(1_000).toISOString(), deliveredAt: null, readAt: null,
  };
  const session = { messages: [requestMessage], requestMessage, localAccountId: 'acct-me' };
  const withReference = cloudSelfAgentExecutionContextMessages({
    definition: null, session, requestContextMessages: cloudDirectMessageContextMessages(requestBody),
  });
  const withoutReference = cloudSelfAgentExecutionContextMessages({ definition: null, session, requestContextMessages: [] });
  assert.deepEqual(withReference, [...withoutReference, reference]);
  assert.equal(withReference.some((message) => message.contextRole === 'runtimeIdentity' || message.contextRole === 'resource'), false);
});

test('a hosted send without reference context is forwarded unchanged', async () => {
  const { state, persisted } = await deliverHostedRequest([]);
  assert.equal('agentContextMessages' in persisted, false);
  assert.deepEqual(persisted.agentRuntimeRoute, route);
  const operations = planCloudSelfAgentSync(state, {});
  assert.equal('contextMessages' in operations[0], false);
  const client = recordingClient();
  await publishCloudSelfAgentOperations({
    accountId: 'acct-me', client, ledger: {}, mergeMessage: () => undefined, operations,
    saveLedger: () => undefined, token: 'token', uploadAttachments: async () => [],
  });
  const envelope = parseCloudDirectMessageEnvelope(client.bodies[0]);
  assert.equal(envelope?.text, 'what did we decide?');
  assert.equal('contextMessages' in (envelope ?? {}), false);
  assert.deepEqual(cloudDirectMessageContextMessages(client.bodies[0]), []);
  assert.deepEqual(cloudDirectMessageContextMessages('plain text'), []);
  assert.deepEqual(cloudDirectMessageContextMessages(encodeCloudDirectMessageEnvelope({
    schemaVersion: 1, kind: 'message', text: 'hi', contextMessages: [identity, resource],
  })), []);
});
