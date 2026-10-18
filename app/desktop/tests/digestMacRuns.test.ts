import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  macCanRunDigest,
  notifyDigestRunRequests,
  parseDigestRunRequest,
  runDigestOnMac,
  setDigestRunRequestHandler,
  type DigestMacRuntime,
} from '../src/features/digest/digestMacRuns';

const localRoute = { model: 'openai/gpt-5.6', authProvider: 'openai', authChoice: 'local-active-oauth', thinking: null };
const request = { runId: 'digest_1', sessionId: 'digest:acct_owner' };

function runtime(overrides: Partial<DigestMacRuntime> & { claim?: unknown } = {}) {
  const calls: Array<{ kind: string; path: string; body: unknown }> = [];
  const value: DigestMacRuntime = {
    accountId: 'acct_owner',
    token: 'token',
    route: localRoute,
    client: {
      desktopAgentExecution: async <T,>(_token: string, action: string, body: unknown) => {
        calls.push({ kind: 'execution', path: action, body });
        return (action === 'claim'
          ? overrides.claim ?? { runId: 'digest_1', acquired: true, digest: { systemPrompt: 'system', prompt: 'prompt', tools: [{ name: 'digest_read_session', description: 'd' }] } }
          : { ok: true }) as T;
      },
    },
    post: async (path, body) => { calls.push({ kind: 'post', path, body }); return { ok: true }; },
    run: async () => '{"claims":[]}',
    ...overrides,
  };
  return { value, calls };
}

test('a Mac runs digests only with a provider on this Mac', () => {
  assert.equal(macCanRunDigest(localRoute), true);
  assert.equal(macCanRunDigest({ ...localRoute, authChoice: 'cloud-login:work' }), false);
  assert.equal(macCanRunDigest({ ...localRoute, model: '' }), false);
  assert.equal(macCanRunDigest(null), false);
});

test('only digest run requests for a digest session are accepted', () => {
  assert.deepEqual(parseDigestRunRequest(request), request);
  assert.equal(parseDigestRunRequest({ runId: 'car_1', sessionId: 'digest:acct_owner' }), null);
  assert.equal(parseDigestRunRequest({ runId: 'digest_1', sessionId: 'session:group:a' }), null);
  const seen: string[] = [];
  notifyDigestRunRequests([{ eventType: 'digest.run_requested', payload: request }]);
  setDigestRunRequestHandler((next) => seen.push(next.runId));
  notifyDigestRunRequests([{ eventType: 'document.agent_request', payload: request }]);
  setDigestRunRequestHandler(null);
  assert.deepEqual(seen, ['digest_1'], 'a request that arrived early waits for the handler');
});

test('a claimed digest run submits the Mac reply for the server checks', async () => {
  const { value, calls } = runtime();
  let ran: unknown = null;
  value.run = async (input) => { ran = input; return '{"claims":[]}'; };
  assert.equal(await runDigestOnMac(request, value), 'completed');
  const claim = calls.find((call) => call.path === 'claim')!.body as Record<string, string>;
  assert.equal(claim.requestMessageId, 'digest_1');
  assert.equal(claim.ownerAccountId, 'acct_owner');
  assert.equal((ran as { systemPrompt: string }).systemPrompt, 'system');
  assert.deepEqual((ran as { route: unknown }).route, localRoute);
  const complete = calls.find((call) => call.path === 'digest/desktop/digest_1/complete')!;
  assert.deepEqual(complete.body, { claimId: claim.claimId, text: '{"claims":[]}' });
});

test('a Mac that cannot finish hands the run to the cloud', async () => {
  const { value, calls } = runtime({ run: async () => { throw new Error('provider failed'); } });
  assert.equal(await runDigestOnMac(request, value), 'released');
  assert.ok(calls.some((call) => call.path === 'digest/desktop/digest_1/release'));
  assert.ok(!calls.some((call) => call.path.endsWith('/complete')));
});

test('a run held elsewhere or for another account is left alone', async () => {
  const held = runtime({ claim: { runId: 'digest_1', acquired: false } });
  assert.equal(await runDigestOnMac(request, held.value), 'not-acquired');
  assert.ok(!held.calls.some((call) => call.kind === 'post'));
  const other = runtime();
  assert.equal(await runDigestOnMac({ ...request, sessionId: 'digest:acct_other' }, other.value), 'skipped');
  assert.equal(other.calls.length, 0);
  const hosted = runtime({ route: { ...localRoute, authChoice: 'cloud-api-key:work' } });
  assert.equal(await runDigestOnMac(request, hosted.value), 'skipped');
  assert.equal(hosted.calls.length, 0, 'a hosted-only route never claims');
});
