import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CloudMessage } from '../src/features/cloud/authClient';
import { parseCloudDirectMessageEnvelope } from '../src/features/cloud/cloudDirectMessages';
import {
  cloudSelfAgentIdentityLedgerKey,
  publishCloudAgentIdentityMarkers,
} from '../src/features/cloud/cloudSelfAgentSessionIdentity';

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
