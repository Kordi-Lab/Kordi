import { describe, expect, test } from 'bun:test';
import type { OAuthCredentials } from '@oh-my-pi/pi-ai';
import * as AIError from '@oh-my-pi/pi-ai/error';
import { OAuthCallbackFlow } from '@oh-my-pi/pi-ai/registry/oauth/callback-server';
import { handleLoginRoute, isSecretPrompt, ompLoginRegistry, type LoginRegistry } from './login-sessions';
import {
  apiKeyProvider,
  deferred,
  fakeRegistry,
  manager,
  policy,
  SYNTHETIC_CREDENTIALS,
  until,
} from './login-test-fixtures';

// Step bridge: OAuthController callbacks to steps, and the internal api-key flow.

/** Fake authorization-code provider driven by OMP's own callback engine in manual mode. */
class FakeCodeFlow extends OAuthCallbackFlow {
  async generateAuthUrl(state: string, redirectUri: string) {
    const query = new URLSearchParams({ state, redirect_uri: redirectUri });
    return { url: `https://auth.example.test/authorize?${query}`, instructions: 'Sign in to Example' };
  }

  async exchangeToken(code: string): Promise<OAuthCredentials> {
    return { ...SYNTHETIC_CREDENTIALS, access: `synthetic-access-for-${code}` };
  }
}

describe('api-key and env-only providers', () => {
  test('emits one api-key step, validates the pasted key, and claims it once', async () => {
    const seen: Array<[string, string, boolean]> = [];
    const registry = fakeRegistry({ 'fake-key': { policy: apiKeyProvider() } }, async (provider, apiKey, signal) => {
      seen.push([provider, apiKey, signal instanceof AbortSignal]);
      return { apiKey: apiKey.trim() };
    });
    const sessions = manager(registry);
    const sessionId = crypto.randomUUID();

    const started = await sessions.start({ provider: 'fake-key', sessionId });
    expect(started.status).toBe('awaiting-input');
    expect(started.step).toEqual({
      type: 'api-key',
      instructions: 'Copy a key from the console',
      prompt: 'Paste your Fake key',
      placeholder: 'fk-...',
      authUrl: 'https://console.example.test/keys',
    });
    expect(registry.controllers).toHaveLength(0);

    sessions.input(sessionId, '  synthetic-fake-key  ');
    const done = await until(sessions, sessionId, (snapshot) => snapshot.status === 'completed');
    expect(done.error).toBeNull();
    expect(seen).toEqual([['fake-key', '  synthetic-fake-key  ', true]]);
    expect(sessions.claim(sessionId)).toEqual({
      provider: 'fake-key',
      material: { apiMode: 'api-key', apiKey: 'synthetic-fake-key', baseUrl: null, api: null },
    });
    expect(() => sessions.claim(sessionId)).toThrow('not_found');
    expect(sessions.size).toBe(0);
  });

  test('a rejected key fails with a fixed classification that never echoes the key', async () => {
    const registry = fakeRegistry({ 'fake-key': { policy: apiKeyProvider() } }, async (_provider, apiKey) => {
      throw new AIError.ProviderHttpError(`Fake API key validation failed (401): unknown key ${apiKey}`, 401);
    });
    const sessions = manager(registry);
    const sessionId = crypto.randomUUID();
    await sessions.start({ provider: 'fake-key', sessionId });
    sessions.input(sessionId, 'synthetic-rejected-key');

    const failed = await until(sessions, sessionId, (snapshot) => snapshot.status === 'failed');
    expect(failed.error).toBe('provider_rejected');
    expect(JSON.stringify(failed)).not.toContain('synthetic-rejected-key');

    const response = await handleLoginRoute(new Request(`http://worker/login/${sessionId}`), sessions);
    expect(await response.text()).not.toContain('synthetic-rejected-key');
    expect(() => sessions.claim(sessionId)).toThrow('not_completed');
  });

  test('env-only providers take a key when OMP names an env var and are unsupported otherwise', async () => {
    const registry = fakeRegistry({
      'fake-env': { policy: policy({ kind: 'env-only', envVars: ['FAKE_API_KEY'] }) },
      'fake-native': { policy: policy({ kind: 'env-only', envVars: [] }) },
    });
    const sessions = manager(registry);
    const started = await sessions.start({ provider: 'fake-env', sessionId: crypto.randomUUID() });
    expect(started.status).toBe('awaiting-input');
    expect(started.step).toEqual({ type: 'api-key', instructions: null, prompt: null, placeholder: null, authUrl: null });
    await expect(sessions.start({ provider: 'fake-native', sessionId: crypto.randomUUID() }))
      .rejects.toThrow('unsupported_flow');
  });
});

describe('OMP controller bridge', () => {
  test('a secret prompt waits for input and completes with OAuth credentials', async () => {
    const registry = fakeRegistry({
      acme: {
        policy: policy({ name: 'Acme' }),
        login: async (controller) => {
          const domain = await controller.onPrompt!({ message: 'Enterprise domain (blank for default)', allowEmpty: true });
          const token = await controller.onPrompt!({ message: 'Paste your access token', placeholder: 'tok-...', secret: true });
          return { access: `${token.trim()}${domain}`, refresh: '', expires: 8.64e15 };
        },
      },
    });
    const sessions = manager(registry);
    const sessionId = crypto.randomUUID();

    const started = await sessions.start({ provider: 'acme', sessionId });
    expect(started.step).toEqual({
      type: 'prompt',
      message: 'Enterprise domain (blank for default)',
      placeholder: null,
      secret: false,
      allowEmpty: true,
    });
    sessions.input(sessionId, '');

    const secret = await until(sessions, sessionId, (snapshot) => snapshot.step?.type === 'prompt' && snapshot.step.secret);
    expect(secret.status).toBe('awaiting-input');
    expect(secret.step).toEqual({ type: 'prompt', message: 'Paste your access token', placeholder: 'tok-...', secret: true, allowEmpty: false });
    expect(() => sessions.input(sessionId, '   ')).toThrow('invalid_input');

    sessions.input(sessionId, 'synthetic-token');
    await until(sessions, sessionId, (snapshot) => snapshot.status === 'completed');
    expect(sessions.claim(sessionId)).toEqual({
      provider: 'acme',
      material: {
        apiMode: 'acme-oauth',
        accessToken: 'synthetic-token',
        refreshToken: null,
        expiresAtMs: 8.64e15,
        email: null,
        orgName: null,
        accountId: null,
        apiEndpoint: null,
        enterpriseUrl: null,
        projectId: null,
        baseUrl: null,
        api: null,
      },
    });
  });

  test('a prompt that names a credential is masked even when OMP does not mark it secret', async () => {
    const secretMessages = [
      'Paste your Alibaba Coding Plan API key',
      'Paste your Cloudflare AI Gateway token/API key',
      'Optional quota reporting: copy Request Headers, then paste the Cookie value here',
      'Enter your account password',
      'Paste the client secret',
      'Provide your service credentials',
    ];
    for (const message of secretMessages) expect([message, isSecretPrompt({ message })]).toEqual([message, true]);
    const plainMessages = ['Enter your Cloudflare account ID', 'Enter custom base URL', 'GitHub Enterprise URL/domain (blank for github.com)'];
    for (const message of plainMessages) expect([message, isSecretPrompt({ message })]).toEqual([message, false]);
    expect(isSecretPrompt({ message: 'Enter the value', secret: true })).toBe(true);

    const registry = fakeRegistry({
      'fake-key-prompt': {
        policy: policy({}),
        login: async (controller) => {
          const key = await controller.onPrompt!({ message: 'Paste your Xiaomi API key (sk-... or token-plan tp-...)' });
          return { ...SYNTHETIC_CREDENTIALS, access: key };
        },
      },
    });
    const sessions = manager(registry);
    const started = await sessions.start({ provider: 'fake-key-prompt', sessionId: crypto.randomUUID() });
    expect(started.step).toMatchObject({ type: 'prompt', secret: true });
    sessions.close();
  });

  test('open-url plus paste-code completes through a pasted redirect URL in OMP\'s callback engine', async () => {
    const registry = fakeRegistry({
      'fake-code': {
        policy: policy({ kind: 'oauth-code', callbackPort: 1455 }),
        login: (controller) => new FakeCodeFlow(controller, {
          preferredPort: 1455,
          callbackPath: '/auth/callback',
          manualInputOnly: true,
        }).login(),
      },
    });
    const sessions = manager(registry);
    const sessionId = crypto.randomUUID();
    await sessions.start({ provider: 'fake-code', sessionId });

    const paste = await until(sessions, sessionId, (snapshot) => snapshot.step?.type === 'paste-code');
    expect(paste.status).toBe('awaiting-input');
    expect(paste.auth?.type).toBe('open-url');
    expect(paste.auth?.launchUrl).toBeNull();
    expect(paste.auth?.instructions).toBe('Sign in to Example');
    const authorize = new URL(paste.auth!.url);
    expect(authorize.origin).toBe('https://auth.example.test');
    expect(authorize.searchParams.get('redirect_uri')).toBe('http://localhost:1455/auth/callback');
    const state = authorize.searchParams.get('state')!;

    // A redirect for a different sign-in is ignored and the engine asks again.
    sessions.input(sessionId, 'http://localhost:1455/auth/callback?code=synthetic-code&state=other-state');
    const retry = await until(sessions, sessionId, (snapshot) => snapshot.status === 'awaiting-input'
      && snapshot.step?.type === 'paste-code' && snapshot.step.instructions.includes('did not contain'));
    expect(retry.auth?.url).toBe(paste.auth!.url);

    sessions.input(sessionId, `http://localhost:1455/auth/callback?code=synthetic-code&state=${state}`);
    await until(sessions, sessionId, (snapshot) => snapshot.status === 'completed');
    const claim = sessions.claim(sessionId);
    expect(claim.material).toMatchObject({
      apiMode: 'fake-code-oauth',
      accessToken: 'synthetic-access-for-synthetic-code',
      refreshToken: 'synthetic-refresh-token',
      email: 'user@example.test',
      accountId: 'synthetic-account',
    });
  });

  test('progress steps keep the sign-in link and user code, and long-polls wake on change', async () => {
    const gate = deferred<OAuthCredentials>();
    const registry = fakeRegistry({
      'fake-device': {
        policy: policy({ kind: 'device-code' }),
        login: async (controller) => {
          controller.onAuth?.({
            url: 'https://device.example.test/activate',
            launchUrl: 'http://localhost:1455/launch',
            instructions: 'Enter code: ABCD-1234',
          });
          controller.onProgress?.('Waiting for device authorization...');
          return gate.promise;
        },
      },
    });
    const sessions = manager(registry);
    const sessionId = crypto.randomUUID();
    await sessions.start({ provider: 'fake-device', sessionId });

    const waiting = await until(sessions, sessionId, (snapshot) => snapshot.step?.type === 'progress');
    expect(waiting.status).toBe('running');
    expect(waiting.step).toEqual({ type: 'progress', message: 'Waiting for device authorization...' });
    expect(waiting.auth).toEqual({
      type: 'open-url',
      url: 'https://device.example.test/activate',
      launchUrl: null,
      instructions: 'Enter code: ABCD-1234',
    });

    const startedAt = Date.now();
    const longPoll = sessions.poll(sessionId, 25, waiting.version);
    gate.resolve(SYNTHETIC_CREDENTIALS);
    const done = await longPoll;
    expect(done.status).toBe('completed');
    expect(Date.now() - startedAt).toBeLessThan(2_000);

    // A stale `after` answers immediately; a terminal session never waits.
    const immediate = await sessions.poll(sessionId, 25, waiting.version);
    expect(immediate.version).toBe(done.version);
  });

  test('input without a pending step is a 409 that does not echo the value', async () => {
    const gate = deferred<OAuthCredentials>();
    const registry = fakeRegistry({
      'fake-device': {
        policy: policy({ kind: 'device-code' }),
        login: async (controller) => {
          controller.onProgress?.('Waiting for device authorization...');
          return gate.promise;
        },
      },
    });
    const sessions = manager(registry);
    const sessionId = crypto.randomUUID();
    await sessions.start({ provider: 'fake-device', sessionId });

    expect(() => sessions.input(sessionId, 'synthetic-unexpected-value')).toThrow('no_pending_input');
    const response = await handleLoginRoute(new Request(`http://worker/login/${sessionId}/input`, {
      method: 'POST',
      body: JSON.stringify({ value: 'synthetic-unexpected-value' }),
    }), sessions);
    expect(response.status).toBe(409);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: 'no_pending_input' });
    expect(text).not.toContain('synthetic-unexpected-value');
    gate.resolve(SYNTHETIC_CREDENTIALS);
  });

  test('browser sessions are rejected as unsupported in hosted mode', async () => {
    const registry = fakeRegistry({
      'fake-sso': {
        policy: policy({}),
        login: async (controller) => {
          await controller.onBrowserSession!({ url: 'https://sso.example.test', cookieNames: ['session'] }, controller.signal);
          return 'unreachable';
        },
      },
    });
    const sessions = manager(registry);
    const sessionId = crypto.randomUUID();
    await sessions.start({ provider: 'fake-sso', sessionId });
    const failed = await until(sessions, sessionId, (snapshot) => snapshot.status === 'failed');
    expect(failed.error).toBe('unsupported_flow');
  });

  test('login-only openai-codex-device claims under openai-codex with the apiMode and endpoint /run expects', async () => {
    const registry: LoginRegistry = {
      ...ompLoginRegistry(async () => { throw new Error('unused'); }),
      login: async () => SYNTHETIC_CREDENTIALS,
    };
    const sessions = manager(registry);
    const sessionId = crypto.randomUUID();
    await sessions.start({ provider: 'openai-codex-device', sessionId });
    await until(sessions, sessionId, (snapshot) => snapshot.status === 'completed');
    const claim = sessions.claim(sessionId);
    expect(claim.provider).toBe('openai-codex');
    expect(claim.material.apiMode).toBe('openai-codex-oauth');
    expect(claim.material).toMatchObject({
      accessToken: 'synthetic-access-token',
      refreshToken: 'synthetic-refresh-token',
      baseUrl: 'https://chatgpt.com/backend-api',
      api: 'openai-codex-responses',
    });
  });
});
