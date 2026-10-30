import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DesktopChatTurnSnapshot } from '../src/kordi-app/types';
import {
  discoverAgentExchangeMacRuns,
  runAgentExchangeOnMac,
  type AgentExchangeMacRun,
  type AgentExchangeMacRuntime,
} from '../src/features/cloud/agentExchangeMacRuns';

const route = { model: 'openai/gpt-5.6', authProvider: 'openai', authChoice: 'local-active-oauth', thinking: null };
const run: AgentExchangeMacRun = {
  runId: 'car_1', requestMessageId: 'agent-exchange:synthetic:request', sessionId: 'session:scheduled:acct_owner',
  requesterAccountId: 'acct_owner', systemPrompt: 'Answer in this shared conversation.', prompt: 'Summarize what changed overnight.',
};

function lease(overrides: Record<string, unknown> = {}) {
  return {
    runId: 'car_1', claimId: 'claim_1', lost: false, deadline: Date.now() + 30_000,
    admitted: async () => true, attach: () => {}, dispose: () => {}, contextMessages: () => [],
    ...overrides,
  };
}

function runtime(overrides: Partial<AgentExchangeMacRuntime> = {}) {
  const requests: Array<{ path: string; body: unknown }> = [];
  const claims: unknown[] = [];
  const value: AgentExchangeMacRuntime = {
    accountId: 'acct_owner', token: 'token', route,
    client: { desktopAgentExecution: async () => { throw new Error('unused'); } },
    request: async (path, _method, body) => { requests.push({ path, body }); return path === 'pending' ? [run] : { ok: true }; },
    acquireLease: (async (_client: unknown, _token: string, input: unknown) => { claims.push(input); return lease(); }) as unknown as AgentExchangeMacRuntime['acquireLease'],
    startTurn: async () => ({ id: 'turn_1', completed: true, succeeded: true, assistantText: 'Nothing changed.' }) as unknown as DesktopChatTurnSnapshot,
    ...overrides,
  };
  return { value, requests, claims };
}

test('a held scheduled run runs on this Mac and its answer goes back to the server', async () => {
  const { value, requests, claims } = runtime();
  assert.equal(await runAgentExchangeOnMac(run, value), 'completed');
  const claim = claims[0] as Record<string, unknown>;
  assert.equal(claim.requestMessageId, 'agent-exchange:synthetic:request');
  assert.equal(claim.requesterAccountId, 'acct_owner');
  assert.deepEqual(requests, [{ path: 'car_1/complete', body: { claimId: 'claim_1', text: 'Nothing changed.' } }]);
});

test('a run this Mac cannot finish is reported, so the server hands it on', async () => {
  const { value, requests } = runtime({
    startTurn: async () => ({ id: 'turn_1', completed: true, succeeded: false, assistantText: '', error: 'provider failed' }) as unknown as DesktopChatTurnSnapshot,
  });
  assert.equal(await runAgentExchangeOnMac(run, value), 'failed');
  assert.deepEqual(requests, [{ path: 'car_1/fail', body: { claimId: 'claim_1' } }]);
});

test('a run another runtime holds is left alone', async () => {
  const { value, requests } = runtime({
    acquireLease: (async () => null) as unknown as AgentExchangeMacRuntime['acquireLease'],
  });
  assert.equal(await runAgentExchangeOnMac(run, value), 'not-acquired');
  assert.equal(requests.length, 0);
});

test('overlapping polls do not duplicate a turn and a failed claim is discoverable again', async () => {
  let release: (() => void) | undefined;
  let claims = 0;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { value } = runtime({ acquireLease: (async () => { claims++; await gate; return null; }) as AgentExchangeMacRuntime['acquireLease'] });
  const active = new Set<string>();
  await discoverAgentExchangeMacRuns(value, active);
  await discoverAgentExchangeMacRuns(value, active);
  assert.equal(claims, 1);
  release!();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(active.size, 0);
  await discoverAgentExchangeMacRuns(value, active);
  assert.equal(claims, 2);
});

test('an expired lease cannot publish failure on behalf of the new executor', async () => {
  const { value, requests } = runtime({
    acquireLease: (async () => lease({ lost: true })) as AgentExchangeMacRuntime['acquireLease'],
    startTurn: async () => { throw new Error('old turn'); },
  });
  assert.equal(await runAgentExchangeOnMac(run, value), 'failed');
  assert.equal(requests.length, 0);
});

test('a recovered execution uses a new local request identity and the stored target route', async () => {
  let requestId = ''; let model: string | null | undefined;
  const { value } = runtime({ startTurn: async (id, _session, _text, _paths, route) => {
    requestId = id; model = route?.model;
    return { id: 'turn', completed: true, succeeded: true, assistantText: 'Reply' } as DesktopChatTurnSnapshot;
  } });
  await runAgentExchangeOnMac({ ...run, runtimeRoute: { defaultModel: 'synthetic/target-model' } }, value);
  assert.equal(requestId, `${run.requestMessageId}:claim_1`);
  assert.equal(model, 'synthetic/target-model');
});

test('a lost completion acknowledgement retries the same result without running another turn', async () => {
  let attempts = 0; let turns = 0;
  const { value } = runtime({
    request: async (path) => { assert.equal(path, 'car_1/complete'); if (++attempts === 1) throw new Error('connection lost'); return { ok: true }; },
    startTurn: async () => { turns++; return { id: 'turn', completed: true, succeeded: true, assistantText: 'Answer' } as DesktopChatTurnSnapshot; },
  });
  assert.equal(await runAgentExchangeOnMac(run, value), 'completed');
  assert.equal(attempts, 2); assert.equal(turns, 1);
});

test('silent continuation acknowledges durably, while empty answers and recipient silence fail', async () => {
  for (const [suffix, text, expected] of [
    ['resume', '{"agentExchangeOutcome":"silent"}', 'completed'],
    ['request', '{"agentExchangeOutcome":"silent"}', 'failed'],
    ['resume', '', 'failed'],
  ]) {
    const { value, requests } = runtime({ startTurn: async () => ({ id: 'turn', completed: true, succeeded: true, assistantText: text }) as DesktopChatTurnSnapshot });
    assert.equal(await runAgentExchangeOnMac({ ...run, requestMessageId: `agent-exchange:synthetic:${suffix}` }, value), expected);
    assert.equal(requests[0].path, expected === 'completed' ? 'car_1/complete' : 'car_1/fail');
  }
});
