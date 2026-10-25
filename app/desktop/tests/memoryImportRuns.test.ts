import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AgentInstructionFile } from '../src/features/memory/memoryImport';
import { memoryImportRoute } from '../src/features/memory/memoryImportClient';
import {
  MEMORY_IMPORT_LEASE_LOST,
  memoryImportNeedsRun,
  startMemoryImportRun,
  type MemoryImportExtractInput,
  type MemoryImportRunDeps,
} from '../src/features/memory/memoryImportRuns';

const hostedRoute = { model: 'openai-codex/gpt-5.5', authProvider: 'openai-codex', authChoice: 'cloud-login:work', thinking: 'high' };
const localRoute = { ...hostedRoute, authChoice: 'local-active-oauth' };
const file = (path: string): AgentInstructionFile => ({
  path, root: '/work', projectName: 'work', fileName: 'AGENTS.md', source: 'Project file', size: 10, modifiedAt: 1,
});

function deps(overrides: Partial<MemoryImportRunDeps> & { claim?: unknown; renewFails?: boolean } = {}) {
  const calls: Array<{ action: string; body: unknown }> = [];
  const invoked: MemoryImportExtractInput[] = [];
  const value: MemoryImportRunDeps = {
    route: hostedRoute,
    localRoute: memoryImportRoute,
    session: async () => ({ token: 'token' }),
    client: {
      desktopAgentExecution: async <T,>(_token: string, action: string, body: unknown) => {
        calls.push({ action, body });
        if (action.endsWith('/renew') && overrides.renewFails) throw new Error('lease lost');
        return (action === 'tasks'
          ? overrides.claim ?? { runId: 'import_1', acquired: true, leaseSeconds: 45 }
          : { ok: true }) as T;
      },
    },
    invoke: async (input) => { invoked.push(input); return '{"memories":[]}'; },
    ...overrides,
  };
  return { value, calls, invoked };
}

test('only a hosted account needs an import run', () => {
  assert.equal(memoryImportNeedsRun(hostedRoute), true);
  assert.equal(memoryImportNeedsRun(localRoute), false);
  assert.equal(memoryImportNeedsRun(null), false);
});

test('a local provider imports directly, with no run', async () => {
  const { value, calls, invoked } = deps({ route: localRoute });
  const run = await startMemoryImportRun(value);
  await run.extract(file('/work/AGENTS.md'), []);
  await run.finish(true);
  assert.equal(calls.length, 0);
  assert.equal(invoked[0].runId, undefined);
  assert.equal(invoked[0].route?.authChoice, 'local-active-oauth');
});

test('a hosted import claims a run, renews it, reads each file under it, and completes', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { value, calls, invoked } = deps();
  const run = await startMemoryImportRun(value);
  const claim = calls[0];
  assert.equal(claim.action, 'tasks');
  const body = claim.body as Record<string, unknown>;
  assert.equal(body.kind, 'memory_import');
  assert.deepEqual(body.runtimeRoute, {
    defaultModel: hostedRoute.model, defaultAuthProvider: 'openai-codex', defaultAuthChoice: 'cloud-login:work', thinking: 'high',
  });
  await run.extract(file('/work/AGENTS.md'), []);
  t.mock.timers.tick(20_000);
  await Promise.resolve();
  await run.extract(file('/work/CLAUDE.md'), []);
  await run.finish(true);
  assert.deepEqual(invoked.map((input) => [input.runId, input.claimId]), [['import_1', body.claimId], ['import_1', body.claimId]]);
  assert.equal(invoked[0].route?.authChoice, 'cloud-login:work');
  assert.equal(invoked[0].route?.thinking, 'low');
  assert.deepEqual(calls.slice(1).map((call) => call.action), ['import_1/renew', 'import_1/complete']);
  assert.deepEqual(calls[2].body, { claimId: body.claimId });
});

test('a refused claim rejects with the server line', async () => {
  const { value, invoked } = deps({ claim: { acquired: false, errorCode: 'import_busy', message: 'Another import is running.' } });
  await assert.rejects(startMemoryImportRun(value), /Another import is running\./);
  assert.equal(invoked.length, 0);
});

test('a failed import releases the run', async () => {
  const { value, calls } = deps();
  const run = await startMemoryImportRun(value);
  await run.finish(false);
  assert.deepEqual(calls.map((call) => call.action), ['tasks', 'import_1/release']);
});

test('a lost lease stops the remaining files and releases', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { value, calls, invoked } = deps({ renewFails: true });
  const run = await startMemoryImportRun(value);
  await run.extract(file('/work/AGENTS.md'), []);
  t.mock.timers.tick(20_000);
  await new Promise((resolve) => { setImmediate(resolve); });
  await assert.rejects(run.extract(file('/work/CLAUDE.md'), []), new RegExp(MEMORY_IMPORT_LEASE_LOST.replace('.', '\\.')));
  await run.finish(true);
  assert.equal(invoked.length, 1);
  assert.equal(calls.at(-1)?.action, 'import_1/release');
});
