import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CloudMessage } from '../src/features/cloud/authClient';
import { parseCloudAgentResponse } from '../src/features/cloud/cloudAgentMessages';
import { parseCloudDirectMessageEnvelope } from '../src/features/cloud/cloudDirectMessages';
import {
  CLOUD_SELF_AGENT_EXECUTION_STREAM_MS,
  cloudSelfAgentProcessingLedgerKey,
  publishCloudSelfAgentExecutionSnapshot,
  publishCloudSelfAgentHeartbeat,
  publishCloudSelfAgentOperations,
} from '../src/features/cloud/cloudSelfAgentForwardExecution';
import type { CloudAgentExecutionSnapshot } from '../src/features/cloud/cloudAgentMessages';
import type {
  CloudSelfAgentSyncLedger,
  CloudSelfAgentSyncOperation,
} from '../src/features/cloud/cloudSelfAgentForwardSync';

test('owner execution streaming is coalesced before it reaches remote history', () => {
  assert.equal(CLOUD_SELF_AGENT_EXECUTION_STREAM_MS, 5_000);
});

test('local-first self-agent publication is idempotent and replays one lifecycle to device B', async () => {
  const messagesByClientId = new Map<string, CloudMessage>();
  const calls: Array<{ body: string; clientMessageId: string }> = [];
  const client = {
    async sendMessage(
      _token: string,
      accountId: string,
      body: string,
      options: {
        sessionId?: string | null;
        clientCreatedAt?: string | null;
        clientMessageId?: string | null;
      },
    ) {
      const clientMessageId = options.clientMessageId?.trim() ?? '';
      calls.push({ body, clientMessageId });
      const existing = messagesByClientId.get(clientMessageId);
      if (existing) return existing;
      const message: CloudMessage = {
        messageId: `cloud-${messagesByClientId.size + 1}`,
        fromAccountId: accountId,
        toAccountId: accountId,
        body,
        sessionId: options.sessionId ?? null,
        createdAt: options.clientCreatedAt ?? new Date().toISOString(),
        deliveredAt: null,
        readAt: null,
      };
      messagesByClientId.set(clientMessageId, message);
      return message;
    },
  };
  const operations: CloudSelfAgentSyncOperation[] = [
    {
      localMessageId: 'local-request',
      sessionId: 'session:self-agent:shared',
      role: 'user',
      text: 'hello',
      parentLocalMessageId: null,
      createdAtMs: 1_000,
      deliveryState: 'sent',
    },
    {
      localMessageId: 'local-response',
      sessionId: 'session:self-agent:shared',
      role: 'agent',
      text: 'one answer',
      parentLocalMessageId: 'local-request',
      createdAtMs: 2_000,
      deliveryState: 'complete',
    },
  ];
  const execution: CloudAgentExecutionSnapshot = {
    phase: 'preparing',
    summary: 'Preparing the response',
    steps: [],
    startedAtMs: 1_000,
    updatedAtMs: 1_001,
    completed: false,
  };
  const publish = async (ledger: CloudSelfAgentSyncLedger) => {
    await publishCloudSelfAgentOperations({
      accountId: 'acct_me',
      client,
      ledger,
      mergeMessage: () => undefined,
      operations,
      saveLedger: () => undefined,
      executionSnapshotForOperation: (operation) => (
        operation.role === 'user' ? execution : undefined
      ),
      token: 'token',
    });
  };

  const completedLedger: CloudSelfAgentSyncLedger = {};
  await publish(completedLedger);
  await publish({});

  assert.equal(messagesByClientId.size, 3);
  assert.equal(new Set(calls.map((call) => call.clientMessageId)).size, 3);
  const published = [...messagesByClientId.values()];
  const processing = published
    .map((message) => parseCloudAgentResponse(message.body))
    .find((response) => response?.deliveryState === 'processing');
  const completed = published
    .map((message) => parseCloudAgentResponse(message.body))
    .find((response) => response?.deliveryState === 'complete');
  assert.equal(processing?.requestId, 'cloud-1');
  assert.deepEqual(processing?.execution, execution);
  assert.equal(completed?.requestId, processing?.requestId);
  assert.equal(completed?.text, 'one answer');
  assert.equal(
    completedLedger[cloudSelfAgentProcessingLedgerKey('local-request')],
    undefined,
  );
});

test('custom agent publication carries its identity to other devices', async () => {
  let publishedBody = '';
  const client = {
    async sendMessage(
      _token: string,
      accountId: string,
      body: string,
      options: { sessionId?: string | null; clientCreatedAt?: string | null },
    ): Promise<CloudMessage> {
      publishedBody = body;
      return {
        messageId: 'cloud-request',
        fromAccountId: accountId,
        toAccountId: accountId,
        body,
        sessionId: options.sessionId ?? null,
        createdAt: options.clientCreatedAt ?? '',
        deliveredAt: null,
        readAt: null,
      };
    },
  };

  await publishCloudSelfAgentOperations({
    accountId: 'acct_me',
    client,
    ledger: {},
    mergeMessage: () => undefined,
    operations: [{
      localMessageId: 'local-request',
      sessionId: 'session:direct-agent:stock',
      role: 'user',
      text: 'who are you',
      parentLocalMessageId: null,
      createdAtMs: 1_000,
      deliveryState: 'sent',
      targetAgentId: 'cloud_agent_stock',
      targetAgentName: 'US Stock Paper Trader',
    }],
    saveLedger: () => undefined,
    shouldPublishProcessing: () => false,
    token: 'token',
  });

  assert.deepEqual(parseCloudDirectMessageEnvelope(publishedBody), {
    schemaVersion: 1,
    kind: 'message',
    text: 'who are you',
    targetCloudAgentId: 'cloud_agent_stock',
    targetCloudAgentName: 'US Stock Paper Trader',
    targetCloudAgentOwnerAccountId: 'acct_me',
  });
});

test('self-agent execution heartbeats are idempotent within one time bucket', async () => {
  const clientMessageIds: string[] = [];
  const client = {
    async sendMessage(
      _token: string,
      accountId: string,
      body: string,
      options: {
        sessionId?: string | null;
        clientCreatedAt?: string | null;
        clientMessageId?: string | null;
      },
    ): Promise<CloudMessage> {
      clientMessageIds.push(options.clientMessageId ?? '');
      return {
        messageId: options.clientMessageId ?? '',
        fromAccountId: accountId,
        toAccountId: accountId,
        body,
        sessionId: options.sessionId ?? null,
        createdAt: options.clientCreatedAt ?? '',
        deliveredAt: null,
        readAt: null,
      };
    },
  };
  const execution: CloudAgentExecutionSnapshot = {
    phase: 'using-tool',
    summary: 'Check disk usage',
    steps: [{
      id: 'tool:shell',
      label: 'Check disk usage',
      state: 'running',
    }],
    updatedAtMs: 60_000,
    completed: false,
  };
  const publish = (nowMs: number) => publishCloudSelfAgentHeartbeat({
    accountId: 'acct_me',
    assistantText: 'The answer is still growing.',
    client,
    cloudRequestMessageId: 'cloud-request',
    execution: { ...execution, updatedAtMs: nowMs },
    localRequestMessageId: 'local-request',
    nowMs,
    sessionId: 'session:self-agent:shared',
    token: 'token',
  });

  const first = await publish(60_001);
  const retry = await publish(89_999);
  const next = await publish(90_000);

  assert.equal(clientMessageIds[0], clientMessageIds[1]);
  assert.notEqual(clientMessageIds[1], clientMessageIds[2]);
  assert.equal(parseCloudAgentResponse(first.body)?.requestId, 'cloud-request');
  assert.equal(
    parseCloudAgentResponse(retry.body)?.execution?.summary,
    'Check disk usage',
  );
  assert.equal(parseCloudAgentResponse(retry.body)?.deliveryState, 'processing');
  assert.equal(
    parseCloudAgentResponse(retry.body)?.text,
    'The answer is still growing.',
  );
  assert.equal(parseCloudAgentResponse(next.body)?.deliveryState, 'processing');
});

test('self-agent execution stream publishes an owner-only lifecycle update', async () => {
  const calls: Array<{ accountId: string; clientMessageId: string; body: string }> = [];
  const client = {
    async sendMessage(
      _token: string,
      accountId: string,
      body: string,
      options: { sessionId?: string | null; clientMessageId?: string | null },
    ): Promise<CloudMessage> {
      calls.push({
        accountId,
        body,
        clientMessageId: options.clientMessageId ?? '',
      });
      return {
        messageId: 'cloud-progress',
        fromAccountId: accountId,
        toAccountId: accountId,
        body,
        sessionId: options.sessionId ?? null,
        createdAt: '2026-08-16T12:00:00Z',
        deliveredAt: null,
        readAt: null,
      };
    },
  };
  const execution: CloudAgentExecutionSnapshot = {
    phase: 'using-tool',
    summary: 'Using Search',
    steps: [{ id: 'tool:search', label: 'Using Search', state: 'running' }],
    startedAtMs: 1_000,
    updatedAtMs: 2_000,
    completed: false,
  };

  const message = await publishCloudSelfAgentExecutionSnapshot({
    accountId: 'acct_me',
    assistantText: 'The rollout is ready so far.',
    client,
    cloudRequestMessageId: 'cloud-request',
    execution,
    localRequestMessageId: 'local-request',
    revision: 3,
    sessionId: 'session:self-agent:shared',
    token: 'token',
  });

  assert.equal(calls[0]?.accountId, 'acct_me');
  assert.match(calls[0]?.clientMessageId ?? '', /:execution:3$/);
  assert.equal(
    parseCloudAgentResponse(message.body)?.text,
    'The rollout is ready so far.',
  );
  assert.equal(
    parseCloudAgentResponse(message.body)?.deliveryState,
    'processing',
  );
  assert.deepEqual(parseCloudAgentResponse(message.body)?.execution, execution);
});

test('historical self-agent recovery does not publish a fake processing state', async () => {
  const publishedBodies: string[] = [];
  const publishedKinds: Array<string | null | undefined> = [];
  const client = {
    async sendMessage(
      _token: string,
      accountId: string,
      body: string,
      options: { sessionId?: string | null; clientMessageId?: string | null },
    ): Promise<CloudMessage> {
      publishedBodies.push(body);
      publishedKinds.push((options as { messageKind?: string | null }).messageKind);
      return {
        messageId: options.clientMessageId ?? `message-${publishedBodies.length}`,
        fromAccountId: accountId,
        toAccountId: accountId,
        body,
        sessionId: options.sessionId ?? null,
        createdAt: new Date().toISOString(),
        deliveredAt: null,
        readAt: null,
      };
    },
  };
  const operations: CloudSelfAgentSyncOperation[] = [
    {
      localMessageId: 'historical-request',
      sessionId: 'session:self-agent:historical',
      role: 'user',
      text: 'old question',
      parentLocalMessageId: null,
      createdAtMs: 1_000,
      deliveryState: 'sent',
    },
    {
      localMessageId: 'historical-response',
      sessionId: 'session:self-agent:historical',
      role: 'agent',
      text: 'old answer',
      parentLocalMessageId: 'historical-request',
      createdAtMs: 2_000,
      deliveryState: 'complete',
    },
  ];

  await publishCloudSelfAgentOperations({
    accountId: 'acct_me',
    client,
    ledger: {},
    mergeMessage: () => undefined,
    operations,
    saveLedger: () => undefined,
    messageKindForOperation: (operation) => (
      operation.role === 'user'
        ? 'canonical-history-user'
        : 'canonical-history-agent'
    ),
    shouldPublishProcessing: () => false,
    token: 'token',
  });

  assert.equal(publishedBodies.length, 2);
  assert.deepEqual(publishedKinds, [
    'canonical-history-user',
    'canonical-history-agent',
  ]);
  assert.equal(
    publishedBodies.some((body) => (
      parseCloudAgentResponse(body)?.deliveryState === 'processing'
    )),
    false,
  );
  assert.equal(
    parseCloudAgentResponse(publishedBodies[1])?.deliveryState,
    'complete',
  );
});
