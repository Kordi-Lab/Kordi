import assert from 'node:assert/strict';
import test from 'node:test';
import {
  planCloudSelfAgentSync,
  seedCloudSelfAgentForwardSyncLedger,
} from '../src/features/cloud/cloudSelfAgentForwardSync';
import type { CanonicalSessionState } from '../src/kordi-app/types';

test('a hosted queued request dispatched after the cutoff remains executable even when drafted earlier', () => {
  const sessionId = 'session:self-agent:queued-hosted';
  const state = {
    sessions: [{ id: sessionId, kind: 'self-agent', status: 'active' }],
    identities: [], participants: [], profile: { humanIdentityId: 'human:me' },
    messages: [{
      id: 'queued-request', sessionId, senderIdentityId: 'human:me', senderRole: 'user',
      messageKind: 'text', contentText: 'Synthetic request', status: 'sent',
      sequenceNum: 1, createdAtMs: 100, updatedAtMs: 210,
      sourceTransport: 'desktop-chat-ui',
      content: {
        queuedMessage: true, queueState: 'sent', deliveryState: 'sent',
        queueUpdatedAtMs: 200,
        agentRuntimeRoute: { model: 'openai/gpt', authProvider: 'openai', authChoice: 'cloud-login:synthetic' },
      },
    }],
  } as unknown as CanonicalSessionState;

  const seeded = seedCloudSelfAgentForwardSyncLedger(state, {}, 250, 150);
  assert.deepEqual(seeded.ledger, {}, 'the delayed dispatch is live, not historical backfill');
  const planned = planCloudSelfAgentSync(state, seeded.ledger, {
    createdAfterMs: 150,
    recoverSessionIds: new Set([sessionId]),
  });
  assert.equal(planned.length, 1);
  assert.equal(planned[0]?.localMessageId, 'queued-request');
  assert.equal(planned[0]?.historyOnly, undefined);
  assert.ok(planned[0]?.agentRuntimeRoute);
});
