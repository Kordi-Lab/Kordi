import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CloudMessage } from '../src/features/cloud/authClient';
import { parseCloudAgentResponse } from '../src/features/cloud/cloudAgentMessages';
import {
  cloudSelfAgentProcessingLedgerKey,
  publishCloudSelfAgentHeartbeat,
  publishCloudSelfAgentOperations,
} from '../src/features/cloud/cloudSelfAgentForwardExecution';
import type {
  CloudSelfAgentSyncLedger,
  CloudSelfAgentSyncOperation,
} from '../src/features/cloud/cloudSelfAgentForwardSync';

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
  const publish = async (ledger: CloudSelfAgentSyncLedger) => {
    await publishCloudSelfAgentOperations({
      accountId: 'acct_me',
      client,
      ledger,
      mergeMessage: () => undefined,
      operations,
      saveLedger: () => undefined,
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
  assert.equal(completed?.requestId, processing?.requestId);
  assert.equal(completed?.text, 'one answer');
  assert.equal(
    completedLedger[cloudSelfAgentProcessingLedgerKey('local-request')],
    undefined,
  );
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
  const publish = (nowMs: number) => publishCloudSelfAgentHeartbeat({
    accountId: 'acct_me',
    client,
    cloudRequestMessageId: 'cloud-request',
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
  assert.equal(parseCloudAgentResponse(retry.body)?.deliveryState, 'processing');
  assert.equal(parseCloudAgentResponse(next.body)?.deliveryState, 'processing');
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
