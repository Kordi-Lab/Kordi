import { cloudAccountAvatarFixture } from './helpers/cloudAccountAvatarFixture';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CloudAccount, CloudMessage } from '../src/features/cloud/authClient';
import { encodeCloudAgentResponse } from '../src/features/cloud/cloudAgentMessages';
import { encodeCloudDirectMessageEnvelope } from '../src/features/cloud/cloudDirectMessages';
import { cloudSelfAgentRequestClientMessageId } from '../src/features/cloud/cloudSelfAgentIdentity';
import { planCloudSelfAgentSync, planCloudSelfAgentCanonicalSync } from '../src/features/cloud/useCloudCollaborationState';
import type { CanonicalSessionMessage, CanonicalSessionState } from '../src/kordi-app/types';

const account: CloudAccount = {
  accountId: 'acct_me',
  displayName: 'Me Cloud',
  primaryEmail: 'me@example.com',
  avatarUrl: null,
  avatar: cloudAccountAvatarFixture,
  nodeId: 'node_me',
  passwordSet: true,
};

test('leased native mirrors do not publish a second self-agent request or reply', () => {
  const sessionId = 'session:self-agent:leased';
  const row = (id: string, sourceTransport: string, senderRole: string, sequenceNum: number,
    content: Record<string, unknown> = {}, parentMessageId: string | null = null): CanonicalSessionMessage => ({
    id, sessionId, senderIdentityId: senderRole === 'user' ? 'human:me' : 'agent:me',
    senderRole, messageKind: senderRole === 'user' ? 'text' : 'agent-turn',
    contentText: senderRole === 'user' ? 'same words' : 'same reply', content,
    parentMessageId, delegatedExchangeId: null, status: senderRole === 'user' ? 'sent' : 'complete',
    sequenceNum, createdAtMs: 1000 + sequenceNum, updatedAtMs: 1000 + sequenceNum,
    sourceTransport, sourceEventId: `${sourceTransport}:${id}`,
  } as CanonicalSessionMessage);
  const original = row('ui-original', 'desktop-chat-ui', 'user', 1, {
    agentRuntimeRoute: { model: 'openai/gpt', authProvider: 'openai', authChoice: 'cloud-login:synthetic' },
  });
  const cloudRequest = { ...row('cloud-original', 'cloud-self-agent', 'user', 2), sourceEventId: 'wire-original' };
  const leasedUserEcho = row('native-echo', 'desktop-chat', 'user', 3, { desktopEntryId: 'wire-original' });
  const leasedReplyEcho = row('native-reply', 'desktop-chat', 'owned-agent', 4, {}, leasedUserEcho.id);
  const separateUser = row('separate-user', 'desktop-chat', 'user', 5, { desktopEntryId: 'different-entry' });
  const separateReply = row('separate-reply', 'desktop-chat', 'owned-agent', 6, {}, separateUser.id);
  const state = {
    sessions: [{ id: sessionId, kind: 'self-agent', status: 'active' }],
    identities: [], participants: [], profile: { humanIdentityId: 'human:me' },
    messages: [original, cloudRequest, leasedUserEcho, leasedReplyEcho, separateUser, separateReply],
  } as unknown as CanonicalSessionState;
  const ledger = { [original.id]: { cloudMessageId: 'wire-original', syncedAtMs: 1000 } };
  const planned = planCloudSelfAgentSync(state, ledger, { createdAfterMs: 900 });
  assert.deepEqual(planned.map((operation) => operation.localMessageId), [separateUser.id, separateReply.id]);

  // The persisted upload ledger remains enough if the Cloud mirror has not hydrated yet.
  const withoutCloudMirror = { ...state, messages: state.messages.filter((message) => message.id !== cloudRequest.id) };
  assert.deepEqual(planCloudSelfAgentSync(withoutCloudMirror, ledger, { createdAfterMs: 900 })
    .map((operation) => operation.localMessageId), [separateUser.id, separateReply.id]);
});

test('historical Cloud export does not suppress a later native turn by entry id alone', () => {
  const sessionId = 'session:self-agent:history';
  const row = (id: string, sourceTransport: string, senderRole: string,
    content: Record<string, unknown>, parentMessageId: string | null = null): CanonicalSessionMessage => ({
    id, sessionId, senderIdentityId: senderRole === 'user' ? 'human:me' : 'agent:me',
    senderRole, messageKind: senderRole === 'user' ? 'text' : 'agent-turn',
    contentText: senderRole === 'user' ? 'same words' : 'response', content,
    parentMessageId, delegatedExchangeId: null, status: senderRole === 'user' ? 'sent' : 'complete',
    sequenceNum: id === 'historical-local' ? 1 : id === 'historical-cloud' ? 2 : id === 'new-native' ? 3 : 4,
    createdAtMs: 1100, updatedAtMs: 1100, sourceTransport, sourceEventId: `${sourceTransport}:${id}`,
  } as CanonicalSessionMessage);
  const historicalLocal = row('historical-local', 'desktop-chat-ui', 'user', {});
  const historicalCloud = { ...row('historical-cloud', 'cloud-self-agent', 'user', {}), sourceEventId: 'wire-history' };
  const newNative = row('new-native', 'desktop-chat', 'user', { desktopEntryId: 'wire-history' });
  const newReply = row('new-reply', 'desktop-chat', 'owned-agent', {}, newNative.id);
  const state = {
    sessions: [{ id: sessionId, kind: 'self-agent', status: 'active' }],
    identities: [], participants: [], profile: { humanIdentityId: 'human:me' },
    messages: [historicalLocal, historicalCloud, newNative, newReply],
  } as unknown as CanonicalSessionState;
  const ledger = { [historicalLocal.id]: { cloudMessageId: 'wire-history', syncedAtMs: 1000 } };
  assert.deepEqual(planCloudSelfAgentSync(state, ledger, { createdAfterMs: 900 })
    .map((operation) => operation.localMessageId), [newNative.id, newReply.id]);
});

test('replay retains the historical reply id but enriches it from the traced leased response', () => {
  const sessionId = 'session:self-agent:alias';
  const wireRequest = 'wire-original';
  const wireEchoRequest = 'wire-echo';
  const wireEchoResponse = 'wire-echo-response';
  const wireDirectResponse = 'wire-direct-response';
  const row = (id: string, sourceTransport: string, senderRole: string,
    sourceEventId: string, parentMessageId: string | null, content: Record<string, unknown>): CanonicalSessionMessage => ({
    id, sessionId, senderIdentityId: senderRole === 'user' ? 'human:me' : 'agent:me',
    senderRole, messageKind: senderRole === 'user' ? 'text' : 'agent-turn',
    contentText: senderRole === 'user' ? 'Question' : 'Earlier answer', content,
    parentMessageId, delegatedExchangeId: null, status: senderRole === 'user' ? 'sent' : 'complete',
    sequenceNum: 1, createdAtMs: 1000, updatedAtMs: 1000, sourceTransport, sourceEventId,
  } as CanonicalSessionMessage);
  const original = row('canonical-original', 'cloud-self-agent', 'user', wireRequest, null, {});
  const nativeEcho = row('canonical-native-echo', 'desktop-chat', 'user', 'native-event', null,
    { desktopEntryId: wireRequest });
  const historicalReply = row('canonical-historical-reply', 'cloud-self-agent', 'owned-agent',
    wireEchoResponse, nativeEcho.id, { cloudRequestMessageId: wireEchoRequest });
  const directReply = row('canonical-direct-reply', 'cloud-self-agent', 'owned-agent',
    wireDirectResponse, null, { cloudRequestMessageId: wireRequest, execution: { phase: 'complete' } });
  const cloud = (messageId: string, body: string, createdAt: string, extra: Partial<CloudMessage> = {}): CloudMessage => ({
    messageId, fromAccountId: account.accountId, toAccountId: account.accountId,
    body, sessionId, createdAt, deliveredAt: null, readAt: null, ...extra,
  });
  const originalWire = cloud(wireRequest, encodeCloudDirectMessageEnvelope({
    schemaVersion: 1, kind: 'message', text: 'Question',
    agentRuntimeRoute: { model: 'openai/gpt', authProvider: 'openai', authChoice: 'cloud-login:synthetic' },
  }), '2026-09-30T01:00:00.000Z', {
    clientMessageId: cloudSelfAgentRequestClientMessageId(sessionId, 'local-original'),
  });
  const echoWire = cloud(wireEchoRequest, 'Question', '2026-09-30T01:00:00.100Z',
    { messageKind: 'canonical-history-user' });
  const echoReply = cloud(wireEchoResponse, encodeCloudAgentResponse({
    requestId: wireEchoRequest, text: 'Earlier answer', deliveryState: 'complete',
  }), '2026-09-30T01:00:00.200Z', {
    messageKind: 'canonical-history-agent', canonicalHistoryLocalMessageId: historicalReply.id,
  });
  const tracedReply = cloud(wireDirectResponse, encodeCloudAgentResponse({
    requestId: wireRequest, text: 'Updated answer', deliveryState: 'complete',
    execution: { phase: 'complete', summary: 'Done', steps: [], updatedAtMs: 1000, completed: true },
  }), '2026-09-30T01:00:00.300Z');
  const state = {
    sessions: [{ id: sessionId, kind: 'self-agent', status: 'active' }],
    identities: [], participants: [], profile: { humanIdentityId: 'human:me' },
    messages: [original, nativeEcho, historicalReply, directReply],
  } as unknown as CanonicalSessionState;
  const hydratedOnly = planCloudSelfAgentCanonicalSync({ account, messages: [], state });
  assert.deepEqual(hydratedOnly.mirrorReconciliations, [{
    preferredMessageId: historicalReply.id, duplicateMessageId: directReply.id,
  }], 'opening an already durable conversation repairs its exact leased reply alias');
  const cloudMessages = [originalWire, echoWire, echoReply, tracedReply];
  const plan = planCloudSelfAgentCanonicalSync({ account, messages: cloudMessages, state });
  assert.deepEqual(plan.mirrorReconciliations, [{
    preferredMessageId: historicalReply.id, duplicateMessageId: directReply.id,
  }]);
  const enriched = plan.messageRequests.find((request) => request.id === historicalReply.id);
  assert.equal(enriched?.contentText, 'Updated answer');
  assert.equal(enriched?.parentMessageId, original.id);
  assert.equal((enriched?.content as Record<string, unknown>)?.cloudRequestMessageId, wireRequest);
  assert.equal(plan.messageRequests.some((request) => request.id === nativeEcho.id), false);
  assert.equal(plan.messageRequests.some((request) => request.id === directReply.id), false);

  const echoOnly = planCloudSelfAgentCanonicalSync({ account, messages: [echoReply], state });
  assert.equal(echoOnly.messageRequests.some((request) => request.sourceEventId === wireEchoResponse), false);
  const originalOnly = planCloudSelfAgentCanonicalSync({ account, messages: [tracedReply], state });
  assert.deepEqual(originalOnly.mirrorReconciliations, [{
    preferredMessageId: historicalReply.id, duplicateMessageId: directReply.id,
  }]);
  assert.equal(originalOnly.messageRequests.some((request) => request.id === historicalReply.id), true);

  const sameRequestEcho = { ...echoReply, body: encodeCloudAgentResponse({
    requestId: wireRequest, text: 'Earlier answer', deliveryState: 'complete',
  }) };
  const nativeParentOnly = { ...state, messages: [nativeEcho, historicalReply, directReply] };
  const sameRequestPlan = planCloudSelfAgentCanonicalSync({
    account, messages: [originalWire, sameRequestEcho, tracedReply], state: nativeParentOnly,
  });
  assert.deepEqual(sameRequestPlan.mirrorReconciliations, [{
    preferredMessageId: historicalReply.id, duplicateMessageId: directReply.id,
  }], 'a native history export of the original request must not duplicate its traced terminal reply');
  assert.equal(sameRequestPlan.messageRequests.some((request) => request.sourceEventId === wireEchoResponse), false);
  assert.equal(sameRequestPlan.messageRequests.find((request) => request.id === historicalReply.id)?.contentText,
    'Updated answer');

  const afterMerge = { ...state, messages: [original, {
    ...historicalReply, parentMessageId: original.id, sourceEventId: wireDirectResponse,
    contentText: 'Updated answer', content: enriched?.content ?? {},
  }] };
  const replay = planCloudSelfAgentCanonicalSync({ account, messages: cloudMessages, state: afterMerge });
  assert.deepEqual(replay.mirrorReconciliations, []);
  assert.equal(replay.messageRequests.some((request) => request.id === directReply.id), false);
  assert.equal(replay.messageRequests.some((request) => request.sourceEventId === wireEchoResponse), false);

  const localOriginal = row('local-original', 'desktop-chat-ui', 'user', 'ui-event', null, {
    agentRuntimeRoute: { model: 'openai/gpt', authProvider: 'openai', authChoice: 'cloud-login:synthetic' },
  });
  const withLocalParent = { ...afterMerge, messages: [localOriginal, {
    ...afterMerge.messages[1], parentMessageId: localOriginal.id,
  }] };
  const localParentReplay = planCloudSelfAgentCanonicalSync({ account, messages: cloudMessages, state: withLocalParent });
  assert.equal(localParentReplay.messageRequests.some((request) => request.sourceEventId === wireEchoResponse), false);
  assert.equal(localParentReplay.messageRequests.some((request) => request.id === directReply.id), false);
});

test('a single traced historical response remains visible when it is the original reply', () => {
  const sessionId = 'session:self-agent:single-history';
  const request = { messageId: 'wire-single', fromAccountId: account.accountId,
    toAccountId: account.accountId, body: encodeCloudDirectMessageEnvelope({
      schemaVersion: 1, kind: 'message', text: 'Question',
      agentRuntimeRoute: { model: 'openai/gpt', authProvider: 'openai', authChoice: 'cloud-login:synthetic' },
    }), sessionId, createdAt: '2026-09-30T01:00:00.000Z', deliveredAt: null, readAt: null } satisfies CloudMessage;
  const reply = { ...request, messageId: 'wire-single-reply',
    messageKind: 'canonical-history-agent', canonicalHistoryLocalMessageId: 'canonical-single-reply',
    createdAt: '2026-09-30T01:00:01.000Z', body: encodeCloudAgentResponse({
      requestId: request.messageId, text: 'Answer', deliveryState: 'complete',
      execution: { phase: 'complete', summary: 'Done', steps: [], updatedAtMs: 1000, completed: true },
    }) } satisfies CloudMessage;
  const state = { sessions: [{ id: sessionId, kind: 'self-agent', status: 'active' }],
    identities: [], participants: [], profile: { humanIdentityId: 'human:me' }, messages: [
      { id: 'canonical-request', sessionId, senderRole: 'user', messageKind: 'text',
        sourceTransport: 'cloud-self-agent', sourceEventId: request.messageId, contentText: 'Question' },
      { id: 'canonical-single-reply', sessionId, senderRole: 'owned-agent', messageKind: 'agent-turn',
        sourceTransport: 'cloud-self-agent', sourceEventId: reply.messageId,
        parentMessageId: 'canonical-request', contentText: 'Answer', status: 'complete' },
    ] } as unknown as CanonicalSessionState;
  const plan = planCloudSelfAgentCanonicalSync({ account, messages: [request, reply], state });
  assert.equal(plan.mirrorReconciliations.length, 0);
  assert.equal(plan.messageRequests.some((message) => message.sourceEventId === reply.messageId), true);
});
