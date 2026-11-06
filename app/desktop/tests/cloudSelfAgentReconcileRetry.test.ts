import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CLOUD_SELF_AGENT_RECONCILE_MAX_RETRY_MS,
  CLOUD_SELF_AGENT_RECONCILE_RETRY_MS,
  cloudSelfAgentReconcileBackoffHolds,
  cloudSelfAgentReconcileRetryMs,
} from '../src/features/cloud/cloudSelfAgentReconcileBackoff';

// Each reconciliation run re-reads the history of every agent chat, so a
// failure that keeps recurring must not repeat that sweep every 30 seconds.
test('repeated reconciliation failures back off exponentially up to a cap', () => {
  assert.equal(cloudSelfAgentReconcileRetryMs(1), CLOUD_SELF_AGENT_RECONCILE_RETRY_MS);
  assert.equal(cloudSelfAgentReconcileRetryMs(2), 2 * CLOUD_SELF_AGENT_RECONCILE_RETRY_MS);
  assert.equal(cloudSelfAgentReconcileRetryMs(3), 4 * CLOUD_SELF_AGENT_RECONCILE_RETRY_MS);
  assert.equal(cloudSelfAgentReconcileRetryMs(50), CLOUD_SELF_AGENT_RECONCILE_MAX_RETRY_MS);
  const failure = { accountId: 'owner', failedAtMs: 0, pendingMessageIds: new Set<string>(), consecutiveFailures: 3 };
  assert.equal(cloudSelfAgentReconcileBackoffHolds(failure, 'owner', 3 * CLOUD_SELF_AGENT_RECONCILE_RETRY_MS, new Set()), true);
  assert.equal(cloudSelfAgentReconcileBackoffHolds(failure, 'owner', 4 * CLOUD_SELF_AGENT_RECONCILE_RETRY_MS, new Set()), false);
  assert.equal(cloudSelfAgentReconcileBackoffHolds(failure, 'owner', 1_000, new Set(['new-message'])), false,
    'a message sent since the failure still forwards at once');
});
