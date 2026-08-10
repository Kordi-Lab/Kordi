import assert from 'node:assert/strict';
import { test } from 'node:test';

import type {
  CloudAgentRun,
  CloudAgentRunClaimInput,
  CloudAuthClient,
} from '../src/features/cloud/authClient';
import {
  CloudAgentFallbackClaimCoordinator,
} from '../src/features/cloud/cloudAgentFallbackClaimCoordinator';

const claim: CloudAgentRunClaimInput = {
  requestMessageId: 'request:one',
  sessionId: 'session:one',
  ownerAccountId: 'owner:one',
  requesterAccountId: 'requester:one',
  prompt: 'Help',
  idempotencyKey: 'claim:one',
};

function clientReturning(status: CloudAgentRun['status']) {
  let calls = 0;
  return {
    client: {
      claimCloudAgentRun: async () => {
        calls += 1;
        return {
          runId: 'run:one',
          status,
          sandboxId: null,
          createdAt: '2026-08-10T00:00:00Z',
          updatedAt: '2026-08-10T00:00:00Z',
        };
      },
    } as CloudAuthClient,
    calls: () => calls,
  };
}

test('claim coordinator distinguishes active ownership from terminal state', async () => {
  const active = clientReturning('running');
  const activeCoordinator = new CloudAgentFallbackClaimCoordinator();
  assert.equal(await activeCoordinator.claim({
    client: active.client,
    claim,
    tokenOverride: 'token',
    reportWarning: () => undefined,
  }), 'claimed');
  assert.equal(await activeCoordinator.claim({
    client: active.client,
    claim,
    tokenOverride: 'token',
    reportWarning: () => undefined,
  }), 'already-claimed');
  assert.equal(active.calls(), 1);

  const terminal = clientReturning('cancelled');
  const terminalCoordinator = new CloudAgentFallbackClaimCoordinator();
  assert.equal(await terminalCoordinator.claim({
    client: terminal.client,
    claim,
    tokenOverride: 'token',
    reportWarning: () => undefined,
  }), 'terminal');
  assert.equal(await terminalCoordinator.claim({
    client: terminal.client,
    claim,
    tokenOverride: 'token',
    reportWarning: () => undefined,
  }), 'terminal');
  assert.equal(terminal.calls(), 1);
});
