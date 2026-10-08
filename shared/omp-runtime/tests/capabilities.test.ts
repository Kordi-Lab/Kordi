import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthStorage, ModelRegistry, SessionManager, createAgentSession } from '@oh-my-pi/pi-coding-agent';
import { ompCapabilityOptions } from '../src/capabilities';

test('shared runs cannot activate OMP Eval even when requested flags are true', () => {
  const options = ompCapabilityOptions({ ownerLocal: false, computer: true, browser: true }, ['kordi_read']);
  expect(options.restrictToolNames).toBe(true);
  expect(options.toolNames).toEqual(['kordi_read']);
  expect(options.settings?.get('computer.enabled')).toBe(false);
  expect(options.settings?.get('browser.enabled')).toBe(false);
  expect(options.disableExtensionDiscovery).toBe(true);
  expect(options.enableMCP).toBe(false);
});

test('connector host tools do not turn on MCP or extension discovery', () => {
  for (const capabilities of [
    { ownerLocal: false, computer: false, browser: false },
    { ownerLocal: true, computer: true, browser: true },
  ]) {
    const plain = ompCapabilityOptions(capabilities, ['kordi_read']);
    const withConnectors = ompCapabilityOptions(capabilities, ['kordi_read', 'gmail.search', 'gmail.send']);
    expect(withConnectors.enableMCP).toBe(false);
    expect(withConnectors.disableExtensionDiscovery).toBe(true);
    expect(withConnectors.enableLsp).toBe(false);
    expect(withConnectors.restrictToolNames).toBe(plain.restrictToolNames);
    expect(withConnectors.toolNames).toEqual(
      capabilities.ownerLocal ? ['kordi_read', 'gmail.search', 'gmail.send', 'eval'] : ['kordi_read', 'gmail.search', 'gmail.send'],
    );
  }
});

test('owner-local run without explicit computer or browser stays restricted', () => {
  const options = ompCapabilityOptions({ ownerLocal: true, computer: false, browser: false }, ['kordi_read']);
  expect(options.restrictToolNames).toBe(true);
  expect(options.toolNames).toEqual(['kordi_read']);
  expect(options.settings?.get('computer.enabled')).toBe(false);
  expect(options.settings?.get('browser.enabled')).toBe(false);
});

test('owner-local authorized computer and browser activate only named Eval capability', () => {
  const options = ompCapabilityOptions({ ownerLocal: true, computer: true, browser: true }, ['kordi_read']);
  expect(options.restrictToolNames).toBe(false);
  expect(options.toolNames).toEqual(['kordi_read', 'eval']);
  expect(options.settings?.get('computer.enabled')).toBe(true);
  expect(options.settings?.get('browser.enabled')).toBe(true);
  expect(options.skills).toEqual([]);
  expect(options.rules).toEqual([]);
  expect(options.contextFiles).toEqual([]);
});

test('real OMP SDK exposes Eval only for an owner-local authorized run', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'kordi-omp-capability-'));
  try {
    const authStorage = await AuthStorage.create(':memory:', {
      configValueResolver: async () => undefined,
      usageProviderResolver: () => undefined,
    });
    for (const capabilities of [
      { ownerLocal: false, computer: false, browser: false },
      { ownerLocal: true, computer: false, browser: false },
      { ownerLocal: true, computer: true, browser: true },
    ]) {
      const options = ompCapabilityOptions(capabilities, ['kordi_read']);
      const modelRegistry = new ModelRegistry(authStorage, join(cwd, 'models.yml'), {
        ignoreLocalModelConfig: true,
        settings: options.settings!,
        cacheDbPath: join(cwd, 'models.db'),
        fetch: async () => { throw new Error('Model discovery is disabled.'); },
      });
      const { session } = await createAgentSession({
        ...options, cwd, agentDir: cwd, authStorage, modelRegistry,
        sessionManager: SessionManager.inMemory(cwd),
        skipPythonPreflight: true,
        customTools: [{ name: 'kordi_read', label: 'Kordi read', description: 'Test host tool',
          parameters: { type: 'object', properties: {} } as never,
          execute: async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
        }],
      });
      try {
        expect([...session.getActiveToolNames()].sort()).toEqual(
          capabilities.computer || capabilities.browser ? ['eval', 'kordi_read'] : ['kordi_read'],
        );
        expect(session.getEvalPreludes().map(prelude => prelude.name).sort()).toEqual(
          capabilities.computer && capabilities.browser ? ['browser', 'computer'] : [],
        );
      } finally {
        await session.dispose();
      }
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 20000);
