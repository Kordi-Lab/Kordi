import { expect, test } from 'bun:test';
import { bundledProviderCatalog, catalogResponseBody, createWorkerFetch, hasWorkerBearer, runLiveHostedTurn } from './live-server';
import { LoginSessionManager, ompLoginRegistry } from './login-sessions';
import { documentationAsPublic } from './network-test-fixtures';

test('catalog exposes OMP provider IDs and model IDs', () => {
  const catalog = bundledProviderCatalog();
  expect(catalog.length).toBeGreaterThan(60);
  expect(catalog.find((provider) => provider.id === 'openai-codex')?.models).toContain('gpt-5.6-sol');
});

test('live worker rejects material from a different saved account before provider access', async () => {
  await expect(runLiveHostedTurn({
    route: { defaultAuthProvider: 'openai', defaultAuthChoice: 'profile:work', defaultModel: 'openai/gpt-5.6-sol' },
    material: { provider: 'openai-codex', authChoice: 'profile:personal', payload: { apiMode: 'openai-codex-oauth', accessToken: 'synthetic' } },
  })).rejects.toThrow('route_mismatch');
});

test('live worker rejects an unknown model before provider access', async () => {
  await expect(runLiveHostedTurn({
    route: { defaultAuthProvider: 'openai', defaultAuthChoice: 'profile:work', defaultModel: 'openai/not-in-omp' },
    material: { provider: 'openai-codex', authChoice: 'profile:work', payload: { apiMode: 'openai-codex-oauth', accessToken: 'synthetic' } },
  })).rejects.toThrow('unsupported_model');
});

test('custom hosted route rejects a private endpoint before sending the API key', async () => {
  await expect(runLiveHostedTurn({
    route: { defaultAuthProvider: 'custom', defaultAuthChoice: 'cloud-api-key:test', defaultModel: 'custom/demo' },
    material: { provider: 'custom', authChoice: 'cloud-api-key:test', payload: { apiKey: 'synthetic', baseUrl: 'http://127.0.0.1:1234/v1' } },
  })).rejects.toThrow('invalid_custom_endpoint');
});

test('catalog login policy carries only display fields and adds the Codex device sign-in', () => {
  const catalog = bundledProviderCatalog();
  const fields = ['kind', 'name', 'instructions', 'prompt', 'placeholder', 'authUrl', 'validates', 'pasteKey',
    'manualOnly', 'callbackPort', 'callbackPath', 'hook', 'apiKeyFormat', 'envVars', 'storeCredentialsAs',
    'acceptsApiKeyMethod'];
  for (const provider of catalog) expect(Object.keys(provider.login)).toEqual(fields);
  const device = catalog.find((provider) => provider.id === 'openai-codex-device');
  expect(device?.models).toEqual([]);
  expect(device?.login).toMatchObject({ kind: 'custom', hook: 'openai-codex-device', storeCredentialsAs: 'openai-codex' });
  expect(catalog.find((provider) => provider.id === 'kimi-code')?.login.instructions).toContain('{user_code}');
  expect(catalog.find((provider) => provider.id === 'openai')?.login.kind).toBe('env-only');
  const acceptsKey = (id: string) => catalog.find((provider) => provider.id === id)?.login.acceptsApiKeyMethod;
  expect([acceptsKey('anthropic'), acceptsKey('openrouter'), acceptsKey('zai'), acceptsKey('openai')]).toEqual([true, true, true, true]);
  expect([acceptsKey('openai-codex'), acceptsKey('openai-codex-device'), acceptsKey('github-copilot')]).toEqual([false, false, false]);
});

test('worker bearer check accepts only the exact token', () => {
  const request = (authorization?: string) => new Request('http://worker/run', {
    headers: authorization === undefined ? {} : { authorization },
  });
  expect(hasWorkerBearer(request('Bearer synthetic-token'), 'synthetic-token')).toBe(true);
  expect(hasWorkerBearer(request('Bearer synthetic-tokex'), 'synthetic-token')).toBe(false);
  expect(hasWorkerBearer(request('Bearer synthetic'), 'synthetic-token')).toBe(false);
  expect(hasWorkerBearer(request('synthetic-token'), 'synthetic-token')).toBe(false);
  expect(hasWorkerBearer(request(), 'synthetic-token')).toBe(false);
});

const customRoute = {
  route: { defaultAuthProvider: 'custom', defaultAuthChoice: 'cloud-api-key:test', defaultModel: 'custom/demo' },
  material: { provider: 'custom', authChoice: 'cloud-api-key:test', payload: { apiKey: 'synthetic', baseUrl: 'https://api.example.com/v1' } },
};

function sse(...events: unknown[]) {
  const body = [...events.map((event) => `data: ${JSON.stringify(event)}\n\n`), 'data: [DONE]\n\n'].join('');
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

test('custom hosted route sends through the guarded fetch with redirects refused', async () => {
  const seen: Array<{ url: string; redirect?: RequestRedirect }> = [];
  const chunk = { id: 'synthetic', object: 'chat.completion.chunk', created: 0, model: 'demo' };
  const result = await runLiveHostedTurn(customRoute, {
    resolveHost: async () => [{ address: '192.0.2.10', family: 4 }],
    isBlockedAddress: documentationAsPublic,
    fetch: async (input, init) => {
      seen.push({ url: input instanceof Request ? input.url : String(input), redirect: init?.redirect });
      return sse(
        { ...chunk, choices: [{ index: 0, delta: { role: 'assistant', content: 'Synthetic reply.' }, finish_reason: null }] },
        { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      );
    },
  });
  expect(result).toEqual({ provider: 'custom', model: 'demo', response: 'Synthetic reply.' });
  expect(seen.length).toBeGreaterThan(0);
  for (const request of seen) {
    expect(request.url.startsWith('https://api.example.com/v1/')).toBe(true);
    expect(request.redirect).toBe('error');
  }
});

test('custom hosted route reports a DNS rebind as an endpoint failure without sending', async () => {
  let lookups = 0;
  let sent = 0;
  await expect(runLiveHostedTurn(customRoute, {
    resolveHost: async () => [{ address: (lookups += 1) === 1 ? '192.0.2.10' : '169.254.169.254', family: 4 }],
    isBlockedAddress: documentationAsPublic,
    fetch: async () => {
      sent += 1;
      return new Response('{}');
    },
  })).rejects.toThrow('invalid_custom_endpoint');
  expect(sent).toBe(0);
});

test('catalog route serves one cached body for the process lifetime', async () => {
  const fetchWorker = createWorkerFetch('synthetic-token', new LoginSessionManager({
    registry: ompLoginRegistry(async () => { throw new Error('unused'); }),
  }));
  const first = await fetchWorker(new Request('http://worker/catalog'));
  const second = await fetchWorker(new Request('http://worker/catalog'));
  expect(first.headers.get('content-type')).toContain('application/json');
  const body = await first.text();
  expect(await second.text()).toBe(body);
  expect(body).toBe(catalogResponseBody());
  expect((JSON.parse(body) as { providers: unknown[] }).providers).toHaveLength(bundledProviderCatalog().length);
});
