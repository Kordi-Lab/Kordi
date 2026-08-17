import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CloudAccount, CloudMessage } from '../src/features/cloud/authClient';
import { cloudDirectPersonSessionId } from '../src/features/cloud/cloudCollaborationState';
import { encodeCloudAgentResponse } from '../src/features/cloud/cloudAgentMessages';
import {
  CLOUD_AGENT_MODEL_CHANGE_MESSAGE_KIND,
  encodeCloudAgentRuntimeRouteChange,
} from '../src/features/cloud/cloudAgentRuntime';
import { encodeCloudGroupControl } from '../src/features/cloud/cloudGroupMessages';
import { cloudContactToContact } from '../src/features/cloud/useCloudContacts';
import {
  shouldRunLocalCloudAgentForCloudMessage,
  cloudAgentResponseExistsForRequest,
  cloudGroupAgentResponseExistsForRequest,
  cloudFallbackClaimErrorIsRetryable,
  cloudFallbackClaimFailureDiagnostic,
  cloudFallbackRunClaimsForMessages,
} from '../src/features/cloud/useCloudCollaborationState';

const account: CloudAccount = {
  accountId: 'acct_me',
  displayName: 'Me Cloud',
  primaryEmail: 'me@example.com',
  avatarUrl: null,
  nodeId: 'node_me',
  passwordSet: true,
};

const peer = cloudContactToContact({
  accountId: 'acct_peer',
  displayName: 'Peer Person',
  avatarUrl: null,
  nodeId: 'node_peer',
  createdAt: '2026-05-11T00:00:00Z',
});

const message: CloudMessage = {
  messageId: 'msg_1',
  fromAccountId: 'acct_peer',
  toAccountId: 'acct_me',
  body: 'hello from cloud',
  createdAt: '2026-05-11T10:00:00Z',
  deliveredAt: null,
  readAt: null,
  direction: 'incoming',
};

test('cloud fallback claim keeps legacy presence conflicts retryable during mixed-version rollout', () => {
  for (const code of ['network_error', 'owner_online', 'agent_not_available', 'rate_limited', 'server_error']) {
    assert.equal(cloudFallbackClaimErrorIsRetryable({ code }), true, code);
  }
  for (const code of ['provider_auth_not_configured', 'requester_mismatch', 'invalid_session']) {
    assert.equal(cloudFallbackClaimErrorIsRetryable({ code }), false, code);
  }
});

test('cloud fallback claim diagnostics retain only a safe code, status, and retry disposition', () => {
  const retryable = cloudFallbackClaimFailureDiagnostic({
    code: 'rate_limited',
    status: 429,
    message: 'secret provider response',
    body: '<html>private</html>',
  });
  assert.deepEqual(retryable, {
    errorCode: 'rate_limited',
    httpStatus: 429,
    retryDisposition: 'retry',
  });

  const unknown = cloudFallbackClaimFailureDiagnostic({
    code: 'private_provider_token',
    status: 999,
    message: 'do not log me',
  });
  assert.deepEqual(unknown, {
    errorCode: 'unknown',
    httpStatus: null,
    retryDisposition: 'terminal',
  });
  assert.equal(JSON.stringify(unknown).includes('private_provider_token'), false);
  assert.equal(JSON.stringify(unknown).includes('do not log me'), false);
});

test('cloud local group owner agent detects existing Cloud fallback response for request', () => {
  const groupId = 'session:group:one';
  const participants = [
    { accountId: 'acct_me', displayName: 'Me Cloud', avatarUrl: null, role: 'person' as const },
    { accountId: 'acct_peer', displayName: 'Peer Person', avatarUrl: null, role: 'admin' as const },
  ];
  const response = encodeCloudGroupControl({
    kind: 'group-message',
    groupId,
    groupSpaceId: groupId,
    groupTitle: null,
    createdByAccountId: 'acct_peer',
    actor: participants[0],
    participants,
    message: {
      id: 'cloudrunmsg_group_answered',
      senderAccountId: 'acct_me',
      text: 'Already answered by Cloud.',
      createdAtMs: 2_000,
      senderKind: 'agent',
      senderDisplayName: "Me Cloud's Kordi",
      deliveryState: 'complete',
      requestId: 'msg:ui:group_request_answered_by_cloud',
      replyToMessageId: 'msg:ui:group_request_answered_by_cloud',
    },
  });

  assert.equal(cloudGroupAgentResponseExistsForRequest({
    localAccountId: 'acct_me',
    requestMessageId: 'msg:ui:group_request_answered_by_cloud',
    messages: [{
      ...message,
      messageId: 'cloudrunmsg_group_answered_row',
      fromAccountId: 'acct_me',
      toAccountId: 'acct_peer',
      body: response,
      direction: 'outgoing',
      sessionId: groupId,
    }],
  }), true);
});

test('cloud local group owner can repair a failed fallback but not replace a Cloud success', () => {
  const groupId = 'session:group:repair';
  const requestMessageId = 'msg:ui:group_repair';
  const participants = [
    { accountId: 'acct_me', displayName: 'Me Cloud', avatarUrl: null, role: 'person' as const },
    { accountId: 'acct_peer', displayName: 'Peer Person', avatarUrl: null, role: 'admin' as const },
  ];
  const response = (deliveryState: 'complete' | 'failed', id: string) => ({
    ...message,
    messageId: `${id}_wire`,
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    direction: 'outgoing' as const,
    sessionId: groupId,
    body: encodeCloudGroupControl({
      kind: 'group-message',
      groupId,
      groupSpaceId: groupId,
      groupTitle: null,
      createdByAccountId: 'acct_peer',
      actor: participants[0],
      participants,
      message: {
        id,
        senderAccountId: 'acct_me',
        text: deliveryState === 'failed' ? 'No provider configured yet.' : 'Cloud answer',
        createdAtMs: 2_000,
        senderKind: 'agent',
        deliveryState,
        requestId: requestMessageId,
        replyToMessageId: requestMessageId,
      },
    }),
  });

  assert.equal(cloudGroupAgentResponseExistsForRequest({
    localAccountId: 'acct_me',
    requestMessageId,
    messages: [response('failed', 'cloudrunmsg_failed')],
    ignoreFailedCloudFallback: true,
  }), false);
  assert.equal(cloudGroupAgentResponseExistsForRequest({
    localAccountId: 'acct_me',
    requestMessageId,
    messages: [response('failed', 'msg:cloud-agent-local-failed')],
    ignoreFailedCloudFallback: true,
  }), true);
  assert.equal(cloudGroupAgentResponseExistsForRequest({
    localAccountId: 'acct_me',
    requestMessageId,
    messages: [response('complete', 'cloudrunmsg_complete')],
    ignoreFailedCloudFallback: true,
  }), true);
});

test('cloud local owner agent detects existing Cloud fallback response for request', () => {
  const request: CloudMessage = {
    ...message,
    messageId: 'msg_request_answered_by_cloud',
    fromAccountId: 'acct_peer',
    toAccountId: 'acct_me',
    body: '@MeCloudKordi can you see the chathiotory?',
    direction: 'incoming',
    createdAt: new Date().toISOString(),
  };
  const cloudResponse: CloudMessage = {
    ...message,
    messageId: 'cloudrunmsg_answered',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    body: encodeCloudAgentResponse({ requestId: request.messageId, text: 'Already answered by Cloud.' }),
    direction: 'outgoing',
    createdAt: new Date().toISOString(),
  };

  assert.equal(cloudAgentResponseExistsForRequest({
    account,
    requestMessageId: request.messageId,
    peerMessages: [request, cloudResponse],
  }), true);
  assert.equal(shouldRunLocalCloudAgentForCloudMessage({
    account,
    peerId: 'acct_peer',
    message: request,
    peerMessages: [request, cloudResponse],
  }), false);

  const processing = {
    ...cloudResponse,
    messageId: 'msg_processing_on_another_device',
    body: encodeCloudAgentResponse({
      requestId: request.messageId,
      text: 'processing...',
      deliveryState: 'processing',
    }),
  };
  assert.equal(shouldRunLocalCloudAgentForCloudMessage({
    account,
    peerId: 'acct_peer',
    message: request,
    peerMessages: [request, processing],
  }), false);
});

test('cloud outgoing remote-agent mentions produce Cloud fallback run claims', () => {
  const request: CloudMessage = {
    ...message,
    messageId: 'msg_agent_request_claim',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    body: '@PeerPersonKordi what is todays weather',
    direction: 'outgoing',
    createdAt: new Date().toISOString(),
  };

  assert.deepEqual(cloudFallbackRunClaimsForMessages({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [request] },
  }), [{
    requestMessageId: 'msg_agent_request_claim',
    sessionId: cloudDirectPersonSessionId('acct_me', 'acct_peer'),
    ownerAccountId: 'acct_peer',
    requesterAccountId: 'acct_me',
    prompt: 'what is todays weather',
    idempotencyKey: 'cloud-agent-fallback:msg_agent_request_claim:acct_peer',
  }]);
});

test('stale self-agent processing produces one durable Cloud fallback claim', () => {
  const now = Date.now();
  const request: CloudMessage = {
    ...message,
    messageId: 'msg_self_request_stale_processing',
    fromAccountId: account.accountId,
    toAccountId: account.accountId,
    body: 'finish this even if device A disconnected',
    direction: 'outgoing',
    sessionId: 'session:self-agent:shared',
    createdAt: new Date(now - 130_000).toISOString(),
  };
  const processing: CloudMessage = {
    ...request,
    messageId: 'msg_self_processing_stale',
    body: encodeCloudAgentResponse({
      requestId: request.messageId,
      text: 'processing...',
      deliveryState: 'processing',
    }),
    createdAt: new Date(now - 129_000).toISOString(),
  };

  assert.deepEqual(cloudFallbackRunClaimsForMessages({
    account,
    contacts: [],
    messagesByPeer: { [account.accountId]: [request, processing] },
    selfAgentFallbackBeforeMs: now - 120_000,
  }), [{
    requestMessageId: request.messageId,
    sessionId: 'session:self-agent:shared',
    ownerAccountId: account.accountId,
    requesterAccountId: account.accountId,
    prompt: 'finish this even if device A disconnected',
    idempotencyKey:
      `cloud-self-agent:${request.sessionId}:${request.messageId}`
      + `:${account.accountId}`,
  }]);

  const completed = {
    ...processing,
    messageId: 'msg_self_completed_once',
    body: encodeCloudAgentResponse({
      requestId: request.messageId,
      text: 'shared result',
      deliveryState: 'complete',
    }),
  };
  assert.deepEqual(cloudFallbackRunClaimsForMessages({
    account,
    contacts: [],
    messagesByPeer: {
      [account.accountId]: [request, processing, completed],
    },
    selfAgentFallbackBeforeMs: now,
  }), []);
});

test('runtime route events never become self-agent fallback prompts or history', () => {
  const now = Date.now();
  const routeChange: CloudMessage = {
    ...message,
    messageId: 'msg_runtime_route_change',
    fromAccountId: account.accountId,
    toAccountId: account.accountId,
    body: encodeCloudAgentRuntimeRouteChange({
      model: 'openai/gpt-5.6-sol',
      authProvider: 'openai',
      authChoice: 'local-active-oauth',
      thinking: 'high',
    }),
    direction: 'outgoing',
    sessionId: 'session:self-agent:runtime-route',
    messageKind: CLOUD_AGENT_MODEL_CHANGE_MESSAGE_KIND,
    createdAt: new Date(now - 140_000).toISOString(),
  };
  const request: CloudMessage = {
    ...routeChange,
    messageId: 'msg_after_runtime_route_change',
    body: 'answer this request once',
    messageKind: null,
    createdAt: new Date(now - 130_000).toISOString(),
  };

  assert.deepEqual(cloudFallbackRunClaimsForMessages({
    account,
    contacts: [],
    messagesByPeer: { [account.accountId]: [routeChange] },
    selfAgentFallbackBeforeMs: now - 120_000,
  }), []);

  const claims = cloudFallbackRunClaimsForMessages({
    account,
    contacts: [],
    messagesByPeer: { [account.accountId]: [routeChange, request] },
    selfAgentFallbackBeforeMs: now - 120_000,
  });
  assert.equal(claims.length, 1);
  assert.equal(claims[0]?.requestMessageId, request.messageId);
  assert.equal(claims[0]?.prompt, 'answer this request once');
});

test('self-agent fallback age uses server delivery time instead of client display time', () => {
  const now = Date.now();
  const request: CloudMessage = {
    ...message,
    messageId: 'msg_self_request_server_time',
    fromAccountId: account.accountId,
    toAccountId: account.accountId,
    body: 'respect server time',
    direction: 'outgoing',
    sessionId: 'session:self-agent:server-time',
    createdAt: new Date(now - 10 * 60_000).toISOString(),
    deliveredAt: new Date(now - 1_000).toISOString(),
  };
  const processing: CloudMessage = {
    ...request,
    messageId: 'msg_self_processing_server_time',
    body: encodeCloudAgentResponse({
      requestId: request.messageId,
      text: 'processing...',
      deliveryState: 'processing',
    }),
    deliveredAt: new Date(now - 500).toISOString(),
  };
  const options = {
    account,
    contacts: [],
    selfAgentFallbackBeforeMs: now - 120_000,
  };

  assert.deepEqual(cloudFallbackRunClaimsForMessages({
    ...options,
    messagesByPeer: { [account.accountId]: [request, processing] },
  }), []);

  const staleByServerTime = [request, processing].map((entry, index) => ({
    ...entry,
    createdAt: new Date(now + 60_000).toISOString(),
    deliveredAt: new Date(now - 130_000 + index).toISOString(),
  }));
  assert.deepEqual(cloudFallbackRunClaimsForMessages({
    ...options,
    messagesByPeer: { [account.accountId]: staleByServerTime },
  }).map((claim) => claim.requestMessageId), [request.messageId]);
});

test('background Cloud fallback recovery never creates a run for a stale request', () => {
  const now = Date.now();
  const staleRequest: CloudMessage = {
    ...message,
    messageId: 'msg_agent_request_stale',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    body: '@PeerPersonKordi this request has expired',
    direction: 'outgoing',
    createdAt: new Date(now - 10 * 60_000 - 1).toISOString(),
  };
  const recentRequest: CloudMessage = {
    ...staleRequest,
    messageId: 'msg_agent_request_recent',
    body: '@PeerPersonKordi this request is current',
    createdAt: new Date(now - 1_000).toISOString(),
  };

  const claims = cloudFallbackRunClaimsForMessages({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [staleRequest, recentRequest] },
    recentSinceMs: now - 10 * 60_000,
  });

  assert.deepEqual(
    claims.map((claim) => claim.requestMessageId),
    ['msg_agent_request_recent'],
  );
  assert.deepEqual(
    cloudFallbackRunClaimsForMessages({
      account,
      contacts: [peer],
      messagesByPeer: { acct_peer: [staleRequest, recentRequest] },
    }).map((claim) => claim.requestMessageId),
    ['msg_agent_request_stale', 'msg_agent_request_recent'],
    'fresh exact claims remain independent of the recovery window',
  );
});

test('background Cloud group handoff recovery uses envelope time, not wire replay time', () => {
  const now = Date.now();
  const groupId = 'session:group:stale-recovery';
  const participants = [
    { accountId: 'acct_me', displayName: 'Me Cloud', avatarUrl: null, role: 'admin' as const },
    { accountId: 'acct_peer', displayName: 'Peer Person', avatarUrl: null, role: 'person' as const },
  ];
  const request = (
    id: string,
    createdAtMs: number,
  ): CloudMessage => ({
    ...message,
    messageId: `wire_${id}`,
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    direction: 'outgoing',
    createdAt: new Date(now).toISOString(),
    sessionId: groupId,
    body: encodeCloudGroupControl({
      kind: 'group-message',
      groupId,
      groupSpaceId: groupId,
      groupTitle: 'Recovery',
      createdByAccountId: 'acct_me',
      actor: participants[0],
      participants,
      message: {
        id,
        senderAccountId: 'acct_me',
        senderKind: 'human',
        text: '@PeerPersonKordi recover this',
        createdAtMs,
      },
    }),
  });
  const stale = request('msg:ui:stale-group-request', now - 10 * 60_000 - 1);
  const recent = request('msg:ui:recent-group-request', now - 1_000);

  assert.deepEqual(
    cloudFallbackRunClaimsForMessages({
      account,
      contacts: [peer],
      messagesByPeer: { acct_peer: [stale, recent] },
      recentSinceMs: now - 10 * 60_000,
    }).map((claim) => claim.requestMessageId),
    ['msg:ui:recent-group-request'],
  );
});
