import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CloudMessage } from '../src/features/cloud/authClient';
import { encodeCloudDirectMessageEnvelope, parseCloudDirectMessageEnvelope } from '../src/features/cloud/cloudDirectMessages';
import {
  cloudAgentSessionTargetFromMessages,
  cloudSelfAgentIdentityLedgerKey,
  publishCloudAgentIdentityMarkers,
} from '../src/features/cloud/cloudSelfAgentSessionIdentity';
import { cloudOperationUuid } from '../src/features/cloud/chatSyncMapping';

test('plain requests inherit the custom agent identity marker for their session', () => {
  const sessionId = 'session:direct-agent:stock';
  const marker = {
    messageId: 'identity-marker',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_me',
    body: encodeCloudDirectMessageEnvelope({
      schemaVersion: 1,
      kind: 'message',
      text: '',
      targetCloudAgentId: 'cloud_agent_stock',
      targetCloudAgentName: 'US Stock Paper Trader',
      targetCloudAgentOwnerAccountId: 'acct_me',
    }),
    sessionId,
    conversationSequence: 1,
    createdAt: '2026-08-20T00:00:00Z',
    deliveredAt: null,
    readAt: null,
  } as CloudMessage;
  const request = {
    ...marker,
    messageId: 'plain-request',
    body: 'hello',
    conversationSequence: 2,
    createdAt: '2026-08-20T00:00:01Z',
  } as CloudMessage;

  assert.deepEqual(
    cloudAgentSessionTargetFromMessages([marker, request], 'acct_me', request),
    {
      targetCloudAgentId: 'cloud_agent_stock',
      targetCloudAgentName: 'US Stock Paper Trader',
    },
  );
});

test('custom agent identity marker is idempotent and carries the selected name', async () => {
  const bodies: string[] = [];
  const client = {
    async sendMessage(
      _token: string,
      accountId: string,
      body: string,
      options: { sessionId?: string | null },
    ): Promise<CloudMessage> {
      bodies.push(body);
      return {
        messageId: 'identity-marker',
        fromAccountId: accountId,
        toAccountId: accountId,
        body,
        sessionId: options.sessionId ?? null,
        createdAt: '2026-08-20T00:00:00Z',
        deliveredAt: null,
        readAt: null,
      };
    },
  };
  const input = {
    accountId: 'acct_me',
    client,
    ledger: {},
    plans: [{
      sessionId: 'session:direct-agent:stock',
      targetAgentId: 'cloud_agent_stock',
      targetAgentName: 'US Stock Paper Trader',
    }],
    token: 'token',
  };

  const first = await publishCloudAgentIdentityMarkers(input);
  const second = await publishCloudAgentIdentityMarkers({ ...input, ledger: first.ledger });

  assert.equal(bodies.length, 1);
  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.equal(
    first.ledger[cloudSelfAgentIdentityLedgerKey(input.plans[0].sessionId)]?.cloudMessageId,
    'identity-marker',
  );
  assert.deepEqual(parseCloudDirectMessageEnvelope(bodies[0]), {
    schemaVersion: 1,
    kind: 'message',
    text: '',
    targetCloudAgentId: 'cloud_agent_stock',
    targetCloudAgentName: 'US Stock Paper Trader',
    targetCloudAgentOwnerAccountId: 'acct_me',
  });
});

test('remote agent identity marker seeds a fresh device without republishing', async () => {
  let sends = 0;
  const sessionId = 'session:direct-agent:stock';
  const result = await publishCloudAgentIdentityMarkers({
    accountId: 'acct_me',
    client: {
      async sendMessage() {
        sends += 1;
        throw new Error('remote marker should prevent send');
      },
    },
    ledger: {},
    plans: [{
      sessionId,
      targetAgentId: 'cloud_agent_stock',
      targetAgentName: 'US Stock Paper Trader',
    }],
    remoteMessages: [{
      id: 'existing-identity-marker',
      client_message_id: cloudOperationUuid(
        `self-agent:${sessionId}:agent-identity`,
      ),
    }],
    token: 'token',
  });

  assert.equal(sends, 0);
  assert.equal(result.changed, true);
  assert.equal(
    result.ledger[cloudSelfAgentIdentityLedgerKey(sessionId)]?.cloudMessageId,
    'existing-identity-marker',
  );
});
