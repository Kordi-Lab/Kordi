import assert from 'node:assert/strict';
import test from 'node:test';
import type { CloudAuthClient } from '../src/features/cloud/authClient';
import type { DesktopAgentBuilderDraft, DesktopAgentBuilderStatus } from '../src/lib/desktop';
import type { ComposerProviderOption } from '../src/kordi-app/components';
import { factoryDraftWithAccount, runFactoryDraftTest } from '../src/kordi-app/agents/factoryTestRun';

const draft: DesktopAgentBuilderDraft = {
  name: 'Synthetic reviewer', role: 'Review', description: '', systemPrompt: 'Review synthetic text.',
  sourceSummary: '', boundaries: [], access: 'only-me', tools: [], plugins: [], skills: [],
  provider: 'openai-codex', authChoice: 'cloud-login:synthetic-owner', model: 'openai/gpt-6-luna', thinking: 'low',
};
const result = { testReport: { passed: true } } as DesktopAgentBuilderStatus;
const option = (providerId: string, choice: string, active = false) => ({
  providerId, value: `${providerId}::${choice}`, label: 'Synthetic account', active,
}) as ComposerProviderOption;

test('legacy drafts resolve an active matching account and explicit accounts never switch', () => {
  const options = [option('anthropic', 'cloud-login:other', true), option('openai-codex', draft.authChoice!, true)];
  assert.equal(factoryDraftWithAccount(draft, options), draft);
  assert.deepEqual(factoryDraftWithAccount({ ...draft, authChoice: null }, options), draft);
  assert.equal(factoryDraftWithAccount({ ...draft, authChoice: null }, [options[0]]).authChoice, null);
  assert.throws(() => factoryDraftWithAccount({ ...draft, authChoice: null }, [
    option('openai-codex', 'cloud-login:one'), option('openai-codex', 'cloud-login:two'),
  ]), /Choose an active account/);
});

function fixture() {
  const calls: Array<{ token: string; path: string; body: unknown }> = [];
  const client = {
    async desktopAgentExecution(token: string, path: string, body: unknown) {
      calls.push({ token, path, body });
      return path === 'tasks' ? { acquired: true, runId: 'factory_synthetic' } : {};
    },
  } as Pick<CloudAuthClient, 'desktopAgentExecution'>;
  return { client, calls, session: async () => ({ token: 'synthetic-session' }) };
}

test('hosted Factory tests claim the exact draft route and leave completion to the native command', async () => {
  const fx = fixture();
  const tested = await runFactoryDraftTest({ ...fx, draft, invoke: async (lease) => {
    assert.equal(lease?.runId, 'factory_synthetic');
    assert.ok(lease?.claimId);
    assert.equal(fx.calls.length, 1);
    return result;
  } });
  assert.equal(tested, result);
  assert.deepEqual(fx.calls.map((call) => call.path), ['tasks']);
  const claim = fx.calls[0].body as { kind: string; runtimeRoute: unknown; claimId: string };
  assert.equal(claim.kind, 'factory_test');
  assert.deepEqual(claim.runtimeRoute, {
    defaultModel: draft.model, defaultAuthProvider: draft.provider, defaultAuthChoice: draft.authChoice,
    thinking: 'low',
  });
});

test('local tests neither claim hosted credentials nor require a Kordi session', async () => {
  const fx = fixture();
  const tested = await runFactoryDraftTest({ ...fx, draft: { ...draft, authChoice: 'profile:synthetic-local' },
    session: async () => { throw new Error('Must not load a session'); },
    invoke: async (lease) => { assert.equal(lease, undefined); return result; },
  });
  assert.equal(tested, result);
  assert.deepEqual(fx.calls, []);
});

test('a failed native test releases its lease without completing it', async () => {
  const fx = fixture();
  await assert.rejects(runFactoryDraftTest({ ...fx, draft, invoke: async () => { throw new Error('Synthetic failure'); } }), /Synthetic failure/);
  assert.deepEqual(fx.calls.map((call) => call.path), ['tasks', 'factory_synthetic/release']);
  const failed = fixture();
  await runFactoryDraftTest({ ...failed, draft, invoke: async () => ({ testReport: { passed: false } }) as DesktopAgentBuilderStatus });
  assert.equal(failed.calls.at(-1)?.path, 'factory_synthetic/release');
});

test('missing sign-in and refused admission never invoke the model', async () => {
  const fx = fixture();
  const invoke = async () => { assert.fail('Model must not run'); return result; };
  await assert.rejects(runFactoryDraftTest({ ...fx, draft, invoke, session: async () => null }), /Sign in to Kordi/);
  const client = { desktopAgentExecution: async () => ({ acquired: false, message: 'A test is already running.' }) } as Pick<CloudAuthClient, 'desktopAgentExecution'>;
  await assert.rejects(runFactoryDraftTest({ ...fx, draft, invoke, client }), /already running/);
  assert.deepEqual(fx.calls, []);
});

test('a rejected native completion remains failed and releases instead of marking the test passed', async () => {
  const fx = fixture();
  let rejectedRenew: (() => void) | undefined;
  const renewal = new Promise<void>((resolve) => { rejectedRenew = resolve; });
  const original = fx.client.desktopAgentExecution;
  fx.client.desktopAgentExecution = async (...args) => {
    if (args[1].endsWith('/renew')) {
      rejectedRenew?.();
      throw new Error('Synthetic lease loss');
    }
    return original(...args);
  };
  const failed = await runFactoryDraftTest({ ...fx, draft, renewMs: 1, invoke: async () => {
    await renewal;
    return { testReport: { passed: false } } as DesktopAgentBuilderStatus;
  } });
  assert.equal(failed.testReport?.passed, false);
  assert.equal(fx.calls.at(-1)?.path, 'factory_synthetic/release');
});


test('switching drafts while loading the account never starts a hosted test', async () => {
  const fx = fixture();
  let current = true;
  await assert.rejects(runFactoryDraftTest({ ...fx, draft, isCurrent: () => current,
    session: async () => { current = false; return { token: 'synthetic-next-account' }; },
    invoke: async () => { assert.fail('A stale draft must not run'); return result; },
  }), /active Factory draft changed/);
  assert.deepEqual(fx.calls, []);
});
