import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CanonicalSessionMessage, CanonicalSessionState } from '../src/kordi-app/types';
import type { CloudAccount, CloudAuthClient, CloudMessage } from '../src/features/cloud/authClient';
import { encodeCloudAgentResponse, parseCloudAgentResponse } from '../src/features/cloud/cloudAgentMessages';
import { CloudAuthError } from '../src/features/cloud/cloudAuthError';
import {
  CLOUD_SELF_AGENT_ABANDONED_REPLY_IDLE_MS,
  CLOUD_SELF_AGENT_ABANDONED_REPLY_TEXT,
} from '../src/features/cloud/cloudSelfAgentAbandonedReplies';
import {
  planInterruptedCloudSelfAgentTurns,
  recoverInterruptedCloudSelfAgentTurns,
} from '../src/features/cloud/cloudSelfAgentInterruptedTurns';
import { stopCloudSelfAgentRequest } from '../src/features/cloud/cloudSelfAgentStopRequest';
import { __setSessionBackendForTests } from '../src/features/cloud/session';
import { planCloudSelfAgentCanonicalSync } from '../src/features/cloud/useCloudCollaborationState';
import { cloudAccountAvatarFixture } from './helpers/cloudAccountAvatarFixture';

const ACCOUNT = 'acct_owner';
const SESSION = 'self-session';
const REQUEST = 'wire-request';
const STARTED_AT_MS = 1_000_000;
const NOW_MS = STARTED_AT_MS + 30 * 24 * 60 * 60_000;

function canonicalRequest(): CanonicalSessionMessage {
  return {
    id: 'msg:ui:request', sessionId: SESSION, senderIdentityId: 'human:me', senderRole: 'user',
    messageKind: 'text', contentText: 'hi', status: 'sent', sequenceNum: 1,
    createdAtMs: STARTED_AT_MS, updatedAtMs: NOW_MS - 1_000,
    sourceTransport: 'cloud-self-agent', sourceEventId: REQUEST, content: null,
  } as unknown as CanonicalSessionMessage;
}

/** A reply stuck in `processing`; its row was rewritten by a recent sync. */
function canonicalProcessingReply(): CanonicalSessionMessage {
  return {
    id: `msg:cloud:self:response:${REQUEST}`, sessionId: SESSION, senderIdentityId: 'agent:me',
    senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: '', status: 'processing',
    sequenceNum: 2, createdAtMs: STARTED_AT_MS + 100, updatedAtMs: NOW_MS - 1_000,
    sourceTransport: 'cloud-self-agent', sourceEventId: 'wire-processing', parentMessageId: 'msg:ui:request',
    content: {
      cloudRequestMessageId: REQUEST, deliveryState: 'processing', executionUpdatedAtMs: STARTED_AT_MS + 200,
      execution: { phase: 'preparing', summary: 'Preparing the response', steps: [], updatedAtMs: STARTED_AT_MS + 200, completed: false },
    },
  } as unknown as CanonicalSessionMessage;
}

function state(messages: CanonicalSessionMessage[]): CanonicalSessionState {
  return {
    sessions: [{ id: SESSION, kind: 'self-agent', title: 'hi', status: 'active', metadata: { cloudSelfAgentSession: true } }],
    identities: [], participants: [], delegatedExchanges: [], presence: [], contextSnapshots: [],
    storagePath: '/fixture/canonical', messages, profile: { humanIdentityId: 'human:me' },
  } as unknown as CanonicalSessionState;
}

function cloudMessage(id: string, body: string, createdAtMs: number): CloudMessage {
  return {
    messageId: id, fromAccountId: ACCOUNT, toAccountId: ACCOUNT, body,
    createdAt: new Date(createdAtMs).toISOString(), deliveredAt: null, readAt: null,
    direction: 'outgoing', sessionId: SESSION,
  };
}

function processingCloudReply(createdAtMs: number) {
  return cloudMessage(`processing-${createdAtMs}`, encodeCloudAgentResponse({
    requestId: REQUEST, text: '', deliveryState: 'processing',
  }), createdAtMs);
}

type Sent = { peer: string; body: string; clientMessageId?: string | null; sessionId?: string | null };

function fakeClient({
  released = false,
  runStatus = null as string | null,
  stopError = null as Error | null,
} = {}) {
  const sent: Sent[] = [];
  const lookups: string[] = [];
  const client = {
    async desktopAgentExecution<T>() {
      return { released, closed: false, published: false } as T;
    },
    async lookupCloudAgentRunForRequest(_token: string, requestId: string) {
      lookups.push(requestId);
      return runStatus
        ? { runId: 'run-1', status: runStatus, sandboxId: null, createdAt: '', updatedAt: '' }
        : null;
    },
    async sendMessage(_token: string, peer: string, body: string, options: { clientMessageId?: string | null; sessionId?: string | null } = {}) {
      sent.push({ peer, body, clientMessageId: options.clientMessageId, sessionId: options.sessionId });
      return cloudMessage(`sent-${sent.length}`, body, NOW_MS);
    },
    async stopCloudAgentRequest() {
      if (stopError) throw stopError;
    },
  };
  return { client, sent, lookups };
}

function plan() {
  return planInterruptedCloudSelfAgentTurns({
    state: state([canonicalRequest(), canonicalProcessingReply()]),
    attemptedRowIds: new Set(),
    activeRequestIds: new Set(),
    loadedAtMs: NOW_MS - 60_000,
    nowMs: NOW_MS,
  });
}

async function recover(
  fake: ReturnType<typeof fakeClient>,
  selfMessages: CloudMessage[] = [],
) {
  const merged: CloudMessage[] = [];
  let syncs = 0;
  const warnings: unknown[] = [];
  await recoverInterruptedCloudSelfAgentTurns(plan(), {
    account: { accountId: ACCOUNT },
    client: fake.client as unknown as CloudAuthClient,
    selfMessages: () => selfMessages,
    mergeMessage: (message) => { merged.push(message); },
    syncMessages: async () => { syncs += 1; },
    reportWarning: (_message, error) => { warnings.push(error); },
    loadToken: async () => 'synthetic-token',
  }, NOW_MS);
  return { merged, syncs, warnings };
}

test('a reply stuck in processing for an old request is planned by its last progress, not its sync time', () => {
  const result = plan();
  assert.deepEqual(result.releaseRequests, [{ sessionId: SESSION, requestId: REQUEST }]);
  assert.deepEqual(result.abandonedRequests, [{ sessionId: SESSION, requestId: REQUEST, lastProgressAtMs: STARTED_AT_MS + 200 }]);
});

test('a processing reply with no run on the server ends with a failed reply', async () => {
  const fake = fakeClient({ released: false, runStatus: null });
  const { merged, syncs, warnings } = await recover(fake);
  assert.deepEqual(warnings, []);
  assert.deepEqual(fake.lookups, [REQUEST]);
  assert.equal(fake.sent.length, 1);
  const [reply] = fake.sent;
  assert.equal(reply.peer, ACCOUNT);
  assert.equal(reply.sessionId, SESSION);
  assert.equal(reply.clientMessageId, `self-agent:${SESSION}:${REQUEST}:ended-without-run`);
  const response = parseCloudAgentResponse(reply.body);
  assert.equal(response?.requestId, REQUEST);
  assert.equal(response?.deliveryState, 'failed');
  assert.equal(response?.text, CLOUD_SELF_AGENT_ABANDONED_REPLY_TEXT);
  assert.equal(merged.length, 1, 'The reply shows before the next sync');
  assert.equal(syncs, 1);
});

test('a processing reply whose run already ended without a reply ends with a failed reply', async () => {
  for (const runStatus of ['failed', 'cancelled', 'completed']) {
    const fake = fakeClient({ released: false, runStatus });
    await recover(fake);
    assert.equal(fake.sent.length, 1, `run status ${runStatus}`);
  }
});

test('a live run keeps its processing reply', async () => {
  for (const runStatus of ['queued', 'leased', 'running']) {
    const fake = fakeClient({ released: false, runStatus });
    const { merged, syncs } = await recover(fake);
    assert.deepEqual(fake.sent, [], `run status ${runStatus}`);
    assert.deepEqual(merged, []);
    assert.equal(syncs, 0);
  }
});

test('a run this device released gets its reply from the server', async () => {
  const fake = fakeClient({ released: true, runStatus: null });
  const { syncs } = await recover(fake);
  assert.deepEqual(fake.lookups, []);
  assert.deepEqual(fake.sent, []);
  assert.equal(syncs, 1);
});

test('a reply another device still updates is left alone', async () => {
  const fake = fakeClient({ released: false, runStatus: null });
  await recover(fake, [processingCloudReply(NOW_MS - CLOUD_SELF_AGENT_ABANDONED_REPLY_IDLE_MS + 60_000)]);
  assert.deepEqual(fake.lookups, []);
  assert.deepEqual(fake.sent, []);
});

async function withSession<T>(run: () => Promise<T>): Promise<T> {
  const session = { token: 'synthetic-token', accountId: ACCOUNT, expiresAt: '2099-01-01' };
  __setSessionBackendForTests({ load: async () => session, save: async () => {}, clear: async () => {} });
  try {
    return await run();
  } finally {
    __setSessionBackendForTests(null);
  }
}

async function stop(fake: ReturnType<typeof fakeClient>, selfMessages: CloudMessage[]) {
  let syncs = 0;
  const stopped = await withSession(() => stopCloudSelfAgentRequest({
    sessionId: SESSION,
    activeRequests: new Map(),
    localTurnRequestIds: new Set<string>(),
    supersededRequestIds: new Set<string>(),
    streamedTextByRequestId: new Map(),
    latest: {
      account: { accountId: ACCOUNT } as CloudAccount,
      client: fake.client as unknown as CloudAuthClient,
      messageIndex: { byPeerId: new Map([[ACCOUNT, selfMessages]]) } as never,
      setLocalTurns: () => {},
      syncMessages: async () => { syncs += 1; },
      reportWarning: () => {},
    },
  }));
  return { stopped, syncs };
}

const requestMessage = cloudMessage(REQUEST, 'hi', STARTED_AT_MS);

test('Stop on a processing reply whose run already finished ends the reply', async () => {
  const fake = fakeClient({
    released: false,
    stopError: new CloudAuthError('agent_run_finished' as never, 'This request already finished.', 409),
  });
  const { stopped, syncs } = await stop(fake, [requestMessage, processingCloudReply(STARTED_AT_MS + 100)]);
  assert.equal(stopped, true);
  assert.equal(fake.sent.length, 1);
  const response = parseCloudAgentResponse(fake.sent[0].body);
  assert.equal(response?.requestId, REQUEST);
  assert.equal(response?.deliveryState, 'cancelled');
  assert.equal(syncs, 1);
});

test('Stop on a processing reply with no run ends the reply', async () => {
  const fake = fakeClient({
    released: false,
    stopError: new CloudAuthError('agent_run_not_found' as never, 'This request has no agent run.', 404),
  });
  const { stopped } = await stop(fake, [requestMessage, processingCloudReply(STARTED_AT_MS + 100)]);
  assert.equal(stopped, true);
  assert.equal(parseCloudAgentResponse(fake.sent[0]?.body ?? '')?.deliveryState, 'cancelled');
});

test('Stop publishes nothing for a request that has no processing reply', async () => {
  const fake = fakeClient({
    released: false,
    stopError: new CloudAuthError('agent_run_not_found' as never, 'This request has no agent run.', 404),
  });
  const { stopped } = await stop(fake, [requestMessage]);
  assert.equal(stopped, false);
  assert.deepEqual(fake.sent, []);
});

test('the published failed reply replaces the processing row on every device', async () => {
  const fake = fakeClient({ released: false, runStatus: null });
  await recover(fake);
  const failed = cloudMessage('ended-reply', fake.sent[0].body, NOW_MS);
  const owner = {
    accountId: ACCOUNT, displayName: 'Owner', primaryEmail: null, avatarUrl: null,
    avatar: cloudAccountAvatarFixture, nodeId: 'node_owner', passwordSet: true,
  } as CloudAccount;
  const local = state([canonicalRequest(), canonicalProcessingReply()]);
  const plan = planCloudSelfAgentCanonicalSync({
    account: owner,
    messages: [requestMessage, processingCloudReply(STARTED_AT_MS + 100), failed],
    state: { ...local, profile: { ...local.profile, humanIdentityId: `human:${ACCOUNT}` } } as CanonicalSessionState,
  });
  const replies = plan.messageRequests.filter((message) => message.senderRole === 'owned-agent');
  assert.equal(replies.length, 1);
  assert.equal(replies[0].id, `msg:cloud:self:response:${REQUEST}`);
  assert.equal(replies[0].status, 'failed');
});
