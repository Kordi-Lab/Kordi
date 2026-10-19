import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CloudAgentRun, CloudAuthClient } from '../src/features/cloud/authClient';
import {
  cloudAgentRunExecutingRequest,
  cloudFallbackRunExecutingRequest,
  cloudFallbackRunOwnership,
} from '../src/features/cloud/cloudAgentRunOwnership';

function run(status: string): CloudAgentRun {
  return {
    runId: 'car_test', status, sandboxId: null, createdAt: '2026-10-18T00:00:00Z',
    updatedAt: '2026-10-18T00:00:00Z', executionBackend: 'cloud',
  } as CloudAgentRun;
}

function client(lookup: () => Promise<CloudAgentRun | null>): CloudAuthClient {
  return { lookupCloudAgentRunForRequest: lookup } as unknown as CloudAuthClient;
}

const input = { token: 'token', requestMessageId: 'request' };

test('the owner Mac still claims a run that is only queued for it', async () => {
  assert.equal(cloudAgentRunExecutingRequest(run('queued')), false);
  for (const status of ['leased', 'running', 'completed']) {
    assert.equal(cloudAgentRunExecutingRequest(run(status)), true, status);
  }
  for (const status of ['failed', 'cancelled']) {
    assert.equal(cloudAgentRunExecutingRequest(run(status)), false, status);
  }
  assert.equal(await cloudFallbackRunExecutingRequest({
    ...input, client: client(async () => run('queued')),
  }), false);
});

test('the no-reply notice waits while a run is pending or the lookup fails', async () => {
  for (const status of ['queued', 'leased', 'running', 'completed']) {
    assert.equal(await cloudFallbackRunOwnership({
      ...input, client: client(async () => run(status)),
    }), 'owned', status);
  }
  assert.equal(await cloudFallbackRunOwnership({
    ...input, client: client(async () => null),
  }), 'not-owned');
  assert.equal(await cloudFallbackRunOwnership({
    ...input, client: client(async () => { throw new Error('offline'); }),
  }), 'unknown');
});
