import { afterEach, describe, expect, test } from 'bun:test';
import { serializeCloudflareAiGatewayCredential } from '@oh-my-pi/pi-catalog/wire/cloudflare-ai-gateway';
import { ompLoginRegistry, type LoginRegistry, type LoginSessionManager } from './login-sessions';
import { manager, until } from './login-test-fixtures';
import { documentationAsPublic, fakeResolver, guardedNetwork, redirectTo } from './network-test-fixtures';
import { providerDefaultEndpoint, resolveLoginEndpoint } from './provider-endpoint';

// Real OMP logins under the worker's outbound guard, and the endpoint stamped on claimed material.
// Every request lands on a stub; names resolve through a fixed table.

const HOSTS = {
  'proxy.example.com': ['192.0.2.44'],
  'metadata.example.com': ['169.254.169.254'],
  'copilot-api.ghe.example.com': ['198.51.100.20'],
  'copilot-api.private.example.com': ['10.20.30.40'],
  'gateway.ai.cloudflare.com': ['198.51.100.30'],
};
const guard = { resolver: fakeResolver(HOSTS), isBlocked: documentationAsPublic };
const unusedValidate: LoginRegistry['validateApiKey'] = async () => { throw new Error('unused'); };

let restoreNetwork: (() => void) | undefined;
afterEach(() => {
  restoreNetwork?.();
  restoreNetwork = undefined;
});

function network(respond: Parameters<typeof guardedNetwork>[1]) {
  const installed = guardedNetwork(HOSTS, respond);
  restoreNetwork = installed.restore;
  return installed;
}

/** Drives OMP's Alibaba Coding Plan login through option 3 (custom base URL) and returns the final snapshot. */
async function alibabaCustomEndpoint(sessions: LoginSessionManager, baseUrl: string) {
  const sessionId = crypto.randomUUID();
  const started = await sessions.start({ provider: 'alibaba-coding-plan', sessionId });
  expect(started.step).toMatchObject({ type: 'prompt', secret: false });
  sessions.input(sessionId, '3');
  const urlPrompt = await until(sessions, sessionId, (snapshot) => snapshot.step?.type === 'prompt'
    && snapshot.step.message.includes('base URL'));
  expect(urlPrompt.step).toMatchObject({ secret: false });
  sessions.input(sessionId, baseUrl);
  const keyPrompt = await until(sessions, sessionId, (snapshot) => snapshot.step?.type === 'prompt'
    && snapshot.step.message.includes('API key'));
  expect(keyPrompt.step).toMatchObject({ secret: true });
  sessions.input(sessionId, 'synthetic-alibaba-key');
  const done = await until(sessions, sessionId, (snapshot) => snapshot.status === 'completed' || snapshot.status === 'failed');
  return { sessionId, done };
}

describe('login flows under the outbound guard', () => {
  test.each([
    ['the plain-http metadata address', 'http://169.254.169.254/latest/meta-data/iam/security-credentials'],
    ['a name resolving to the metadata address', 'https://metadata.example.com/latest/meta-data'],
  ])('a custom endpoint at %s is refused before the key leaves the worker', async (_name, baseUrl) => {
    const { seen } = network(() => Response.json({ data: [] }));
    const sessions = manager(ompLoginRegistry(unusedValidate, guard));
    const { sessionId, done } = await alibabaCustomEndpoint(sessions, baseUrl);
    expect(done.status).toBe('failed');
    expect(done.error).toBe('invalid_input');
    expect(seen).toHaveLength(0);
    expect(() => sessions.claim(sessionId)).toThrow('not_completed');
  });

  test('a custom endpoint that redirects to a private address is refused at the redirect', async () => {
    const { seen } = network(() => redirectTo('http://169.254.169.254/latest/meta-data/'));
    const sessions = manager(ompLoginRegistry(unusedValidate, guard));
    const { done } = await alibabaCustomEndpoint(sessions, 'https://proxy.example.com/v1');
    expect(done.error).toBe('invalid_input');
    expect(seen.map((request) => request.url)).toEqual(['https://proxy.example.com/v1/models']);
  });

  test('a public custom endpoint passes the guard and becomes the claimed base URL', async () => {
    const { seen } = network(() => Response.json({ data: [] }));
    const sessions = manager(ompLoginRegistry(unusedValidate, guard));
    const { sessionId, done } = await alibabaCustomEndpoint(sessions, 'https://proxy.example.com/v1/');
    expect(done.status).toBe('completed');
    expect(seen.map((request) => request.url)).toEqual(['https://proxy.example.com/v1/models']);
    expect(sessions.claim(sessionId)).toMatchObject({
      provider: 'alibaba-coding-plan',
      material: {
        apiMode: 'alibaba-coding-plan-oauth',
        accessToken: 'synthetic-alibaba-key',
        enterpriseUrl: 'https://proxy.example.com/v1',
        baseUrl: 'https://proxy.example.com/v1',
        api: 'openai-completions',
      },
    });
  });
});

describe('claimed material endpoint', () => {
  test('an api-key claim for mistral carries the Mistral base URL and api kind', async () => {
    const sessions = manager(ompLoginRegistry(async (_provider, apiKey) => ({ apiKey: apiKey.trim() })));
    const sessionId = crypto.randomUUID();
    const started = await sessions.start({ provider: 'mistral', sessionId });
    expect(started.step?.type).toBe('api-key');
    sessions.input(sessionId, 'synthetic-mistral-key');
    await until(sessions, sessionId, (snapshot) => snapshot.status === 'completed');
    expect(sessions.claim(sessionId)).toEqual({
      provider: 'mistral',
      material: {
        apiMode: 'api-key',
        apiKey: 'synthetic-mistral-key',
        baseUrl: 'https://api.mistral.ai/v1',
        api: 'openai-completions',
      },
    });
  });

  test('a GitHub Copilot enterprise sign-in claims its enterprise endpoint only when it is public', async () => {
    const copilot = (enterpriseUrl: string): LoginRegistry => ({
      ...ompLoginRegistry(unusedValidate, guard),
      login: async () => ({
        access: 'synthetic-copilot-token',
        refresh: 'synthetic-github-token',
        expires: Date.now() + 3_600_000,
        enterpriseUrl,
      }),
    });
    const sessions = manager(copilot('ghe.example.com'));
    const sessionId = crypto.randomUUID();
    await sessions.start({ provider: 'github-copilot', sessionId });
    await until(sessions, sessionId, (snapshot) => snapshot.status === 'completed');
    expect(sessions.claim(sessionId).material).toMatchObject({
      apiMode: 'github-copilot-oauth',
      enterpriseUrl: 'ghe.example.com',
      baseUrl: 'https://copilot-api.ghe.example.com',
      api: 'openai-responses',
    });

    const privateSessions = manager(copilot('private.example.com'));
    const privateId = crypto.randomUUID();
    await privateSessions.start({ provider: 'github-copilot', sessionId: privateId });
    const failed = await until(privateSessions, privateId, (snapshot) => snapshot.status === 'failed');
    expect(failed.error).toBe('invalid_input');
  });

  test('OMP templates never become a guessed host, and login-chosen routing fills them', async () => {
    expect(providerDefaultEndpoint('bedrock-mantle')).toEqual({ baseUrl: null, api: 'openai-responses' });
    expect(providerDefaultEndpoint('openai-codex')).toEqual({ baseUrl: 'https://chatgpt.com/backend-api', api: 'openai-codex-responses' });
    const gateway = serializeCloudflareAiGatewayCredential('synthetic-gateway-token', 'account-1', 'gateway-1');
    expect(await resolveLoginEndpoint('cloudflare-ai-gateway', gateway, guard)).toEqual({
      baseUrl: 'https://gateway.ai.cloudflare.com/v1/account-1/gateway-1/anthropic',
      api: 'anthropic-messages',
    });
  });
});
