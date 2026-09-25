import { describe, expect, test } from 'bun:test';
import { getProviderDefinition } from '@oh-my-pi/pi-ai';
import { validateHostedApiKey } from './live-server';
import { handleLoginRoute, ompLoginRegistry, type LoginSnapshot } from './login-sessions';
import { manager, until } from './login-test-fixtures';

function startRequest(body: unknown) {
  return new Request('http://worker/login/start', { method: 'POST', body: JSON.stringify(body) });
}

// Real OMP providers, checked offline: definitions exist and oauth-code runs manual-only.

describe('real OMP definitions', () => {
  test('anthropic and openai-codex-device expose login without being invoked', () => {
    const anthropic = getProviderDefinition('anthropic');
    expect(typeof anthropic?.login).toBe('function');
    const device = getProviderDefinition('openai-codex-device');
    expect(typeof device?.login).toBe('function');
    expect(device?.storeCredentialsAs).toBe('openai-codex');
  });

  test('hosted oauth-code logins run manual-only on the registered redirect URI without network', async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error('network is disabled in this test');
    }) as unknown as typeof fetch;
    const sessions = manager(ompLoginRegistry(async () => { throw new Error('unused'); }));
    try {
      const expectations: Array<[string, string, string]> = [
        ['anthropic', 'https://claude.ai', 'http://localhost:54545/callback'],
        // Two concurrent Codex logins: a bound listener on fixed port 1455 would make the second fail.
        ['openai-codex', 'https://auth.openai.com', 'http://localhost:1455/auth/callback'],
        ['openai-codex', 'https://auth.openai.com', 'http://localhost:1455/auth/callback'],
      ];
      const ids = expectations.map(() => crypto.randomUUID());
      for (const [index, [provider]] of expectations.entries()) {
        await sessions.start({ provider, sessionId: ids[index] });
      }
      for (const [index, [, origin, redirectUri]] of expectations.entries()) {
        const snapshot = await until(sessions, ids[index]!, (next) => next.step?.type === 'paste-code' || next.status === 'failed');
        expect(snapshot.status).toBe('awaiting-input');
        expect(snapshot.auth?.launchUrl).toBeNull();
        const authorize = new URL(snapshot.auth!.url);
        expect(authorize.origin).toBe(origin);
        expect(authorize.searchParams.get('redirect_uri')).toBe(redirectUri);
      }
      for (const sessionId of ids) expect(sessions.cancel(sessionId).status).toBe('cancelled');
      expect(fetchCalls).toBe(0);
    } finally {
      sessions.close();
      globalThis.fetch = originalFetch;
    }
  });

  test('anthropic also accepts an API key through the api-key method, unverified and offline', async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error('network is disabled in this test');
    }) as unknown as typeof fetch;
    const sessions = manager(ompLoginRegistry((provider, apiKey, signal) => validateHostedApiKey(provider, apiKey, signal)));
    try {
      const sessionId = crypto.randomUUID();
      const response = await handleLoginRoute(startRequest({ provider: 'anthropic', sessionId, method: 'api-key' }), sessions);
      expect(response.status).toBe(202);
      const started = await response.json() as LoginSnapshot;
      expect(started.status).toBe('awaiting-input');
      expect(started.step).toEqual({ type: 'api-key', instructions: null, prompt: null, placeholder: null, authUrl: null });

      sessions.input(sessionId, '  synthetic-anthropic-key  ');
      await until(sessions, sessionId, (snapshot) => snapshot.status === 'completed');
      expect(sessions.claim(sessionId)).toEqual({
        provider: 'anthropic',
        material: {
          apiMode: 'api-key',
          apiKey: 'synthetic-anthropic-key',
          baseUrl: 'https://api.anthropic.com',
          api: 'anthropic-messages',
        },
      });
      expect(fetchCalls).toBe(0);
    } finally {
      sessions.close();
      globalThis.fetch = originalFetch;
    }
  });

  test('the api-key method is unsupported for Codex and unknown methods are invalid', async () => {
    const sessions = manager(ompLoginRegistry(async () => { throw new Error('unused'); }));
    const codex = await handleLoginRoute(
      startRequest({ provider: 'openai-codex', sessionId: crypto.randomUUID(), method: 'api-key' }),
      sessions,
    );
    expect(codex.status).toBe(422);
    expect(await codex.json()).toEqual({ error: 'unsupported_flow' });

    const invalid = await handleLoginRoute(
      startRequest({ provider: 'anthropic', sessionId: crypto.randomUUID(), method: 'password' }),
      sessions,
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: 'invalid_request' });
    expect(sessions.size).toBe(0);
  });
});
