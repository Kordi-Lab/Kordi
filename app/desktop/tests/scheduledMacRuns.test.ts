import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DesktopChatTurnSnapshot } from '../src/kordi-app/types';
import {
  discoverScheduledMacRuns,
  runScheduledOnMac,
  type ScheduledMacRun,
  type ScheduledMacRuntime,
} from '../src/features/cloud/scheduledMacRuns';

const route = { model: 'openai/gpt-5.6', authProvider: 'openai', authChoice: 'local-active-oauth', thinking: null };
const run: ScheduledMacRun = {
  runId: 'car_1', requestMessageId: 'scheduled_run_1', sessionId: 'session:scheduled:acct_owner',
  requesterAccountId: 'acct_owner', prompt: 'Summarize what changed overnight.',
};

function lease(overrides: Record<string, unknown> = {}) {
  return {
    runId: 'car_1', claimId: 'claim_1', lost: false, deadline: Date.now() + 30_000,
    admitted: async () => true, attach: () => {}, dispose: () => {}, contextMessages: () => [],
    ...overrides,
  };
}

function runtime(overrides: Partial<ScheduledMacRuntime> = {}) {
  const requests: Array<{ path: string; body: unknown }> = [];
  const claims: unknown[] = [];
  const value: ScheduledMacRuntime = {
    accountId: 'acct_owner', token: 'token', route,
    client: { desktopAgentExecution: async () => { throw new Error('unused'); } },
    request: async (path, _method, body) => { requests.push({ path, body }); return path === 'pending' ? [run] : { ok: true }; },
    acquireLease: (async (_client: unknown, _token: string, input: unknown) => { claims.push(input); return lease(); }) as unknown as ScheduledMacRuntime['acquireLease'],
    startTurn: async () => ({ id: 'turn_1', completed: true, succeeded: true, assistantText: 'Nothing changed.' }) as unknown as DesktopChatTurnSnapshot,
    ...overrides,
  };
  return { value, requests, claims };
}

test('a held scheduled run runs on this Mac and its answer goes back to the server', async () => {
  const { value, requests, claims } = runtime();
  assert.equal(await runScheduledOnMac(run, value), 'completed');
  const claim = claims[0] as Record<string, unknown>;
  assert.equal(claim.requestMessageId, 'scheduled_run_1');
  assert.equal(claim.requesterAccountId, 'acct_owner');
  assert.deepEqual(requests, [{ path: 'car_1/complete', body: { claimId: 'claim_1', text: 'Nothing changed.' } }]);
});

test('a run this Mac cannot finish is reported, so the server hands it on', async () => {
  const { value, requests } = runtime({
    startTurn: async () => ({ id: 'turn_1', completed: true, succeeded: false, assistantText: '', error: 'provider failed' }) as unknown as DesktopChatTurnSnapshot,
  });
  assert.equal(await runScheduledOnMac(run, value), 'failed');
  assert.deepEqual(requests, [{ path: 'car_1/fail', body: { claimId: 'claim_1' } }]);
});

test('a run another runtime holds is left alone', async () => {
  const { value, requests } = runtime({
    acquireLease: (async () => null) as unknown as ScheduledMacRuntime['acquireLease'],
  });
  assert.equal(await runScheduledOnMac(run, value), 'not-acquired');
  assert.equal(requests.length, 0);
});

test('each held run is started once per Mac session', async () => {
  const { value, claims } = runtime();
  const started = new Set<string>();
  await discoverScheduledMacRuns(value, started);
  await discoverScheduledMacRuns(value, started);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(claims.length, 1);
  assert.deepEqual([...started], ['scheduled_run_1']);
});
