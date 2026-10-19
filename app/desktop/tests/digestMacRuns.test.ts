import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  digestRunRoute,
  macCanRunDigest,
  notifyDigestRunRequests,
  parseDigestRunRequest,
  runDigestOnMac,
  setDigestRunRequestHandler,
  type DigestMacRuntime,
} from '../src/features/digest/digestMacRuns';

const localRoute = { model: 'openai/gpt-5.6', authProvider: 'openai', authChoice: 'local-active-oauth', thinking: null };
const fastModels = { anthropic: 'claude-haiku-4-5', openai: 'gpt-5.6-luna', 'openai-codex': 'gpt-5.6-luna' };
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

test('a Mac runs digests with any model route, a hosted account included', () => {
  assert.equal(macCanRunDigest(localRoute), true);
  assert.equal(macCanRunDigest({ ...localRoute, authChoice: 'cloud-login:work' }), true);
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
  assert.deepEqual((ran as { route: unknown }).route, { ...localRoute, thinking: 'low' });
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
});

test('a hosted account runs the digest on this Mac and names that account in the claim', async () => {
  const hostedRoute = { ...localRoute, authChoice: 'cloud-login:work' };
  const hosted = runtime({ route: hostedRoute });
  let ran: unknown = null;
  hosted.value.run = async (input) => { ran = input; return '{"claims":[]}'; };
  assert.equal(await runDigestOnMac(request, hosted.value), 'completed');
  const claim = hosted.calls.find((call) => call.path === 'claim')!.body as Record<string, unknown>;
  assert.deepEqual(claim.runtimeRoute, {
    defaultModel: hostedRoute.model, defaultAuthProvider: 'openai', defaultAuthChoice: 'cloud-login:work', thinking: null,
  });
  assert.deepEqual((ran as { route: unknown }).route, { ...hostedRoute, thinking: 'low' });
  const local = runtime();
  await runDigestOnMac(request, local.value);
  const localClaim = local.calls.find((call) => call.path === 'claim')!.body as Record<string, unknown>;
  assert.equal(localClaim.runtimeRoute, undefined, 'a Mac-local route never replaces the cloud route');
});

test('a Mac runs the digest with the digest model choice, not its chat effort', () => {
  const chat = { ...localRoute, thinking: 'xhigh' };
  // The cloud chose the fast model of the same provider.
  assert.deepEqual(
    digestRunRoute(chat, { model: 'gpt-5.6-luna', thinking: 'low', provider: 'openai', modelChoice: 'fast', fastModels }),
    { route: { ...chat, model: 'openai/gpt-5.6-luna', thinking: 'low' }, fallbackModel: null },
  );
  // A choice made for another provider becomes this provider's fast model.
  assert.deepEqual(
    digestRunRoute(chat, { model: 'claude-haiku-4-5', thinking: 'low', provider: 'anthropic', modelChoice: 'fast', fastModels }).route,
    { ...chat, model: 'openai/gpt-5.6-luna', thinking: 'low' },
  );
  // A named model of this provider runs, with the fast model if it is not available here.
  assert.deepEqual(
    digestRunRoute(chat, { model: 'openai/gpt-5.5', thinking: 'medium', provider: 'openai', modelChoice: 'named', fastModels }),
    { route: { ...chat, model: 'openai/gpt-5.5', thinking: 'medium' }, fallbackModel: 'openai/gpt-5.6-luna' },
  );
  // The owner chose the chat's own model: this Mac's chat route runs.
  assert.deepEqual(digestRunRoute(chat, { model: 'anthropic/claude-opus-4-8', thinking: 'high', provider: 'anthropic', modelChoice: 'chat', fastModels }).route, chat);
  // A claim without a choice still never runs at the chat's effort.
  assert.equal(digestRunRoute(chat, {}).route.thinking, 'low');
});

test('the quick urgency check runs on this Mac without tools or thinking', async () => {
  const chat = { ...localRoute, thinking: 'high' };
  assert.deepEqual(
    digestRunRoute(chat, { model: 'gpt-5.6-luna', thinking: 'low', provider: 'openai', modelChoice: 'chat', triage: true, fastModels }).route,
    { ...chat, thinking: 'off' },
  );
  const { value } = runtime({
    route: chat,
    claim: { runId: 'digest_1', acquired: true, digest: {
      systemPrompt: 'check', prompt: 'messages', tools: [], model: 'gpt-5.6-luna', thinking: 'off',
      provider: 'openai', modelChoice: 'fast', triage: true, fastModels,
    } },
  });
  let ran: { route: unknown; tools: unknown; fallbackModel: unknown } | null = null;
  value.run = async (input) => { ran = input; return '{"urgent":true}'; };
  assert.equal(await runDigestOnMac(request, value), 'completed');
  assert.deepEqual(ran!.route, { ...chat, model: 'openai/gpt-5.6-luna', thinking: 'off' });
  assert.deepEqual(ran!.tools, []);
  assert.equal(ran!.fallbackModel, null);
});
