import { afterEach, describe, expect, test } from 'bun:test';
import { bundledProviderCatalog, createWorkerFetch, validateHostedApiKey } from './live-server';
import { handleLoginRoute, ompLoginRegistry } from './login-sessions';
import { manager } from './login-test-fixtures';
import { guardedNetwork, type StubResponder } from './network-test-fixtures';

// `/run` and `/validate-key` error codes, `verified` semantics, and the shared accepts-key rule.
// Provider probes land on a stub behind the outbound guard; nothing reaches the network.

const token = 'synthetic-worker-token';
const HOSTS = { 'integrate.api.nvidia.com': ['192.0.2.30'], 'api.x.ai': ['192.0.2.31'] };

let restoreNetwork: (() => void) | undefined;
afterEach(() => {
  restoreNetwork?.();
  restoreNetwork = undefined;
});

function network(respond: StubResponder) {
  const installed = guardedNetwork(HOSTS, respond);
  restoreNetwork = installed.restore;
  return installed;
}

const worker = () => createWorkerFetch(token, manager(ompLoginRegistry(validateHostedApiKey)));

function post(path: string, body: unknown) {
  return new Request(`http://worker${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function failure(response: Response) {
  return { status: response.status, body: await response.json() as unknown };
}

const codexRoute = { defaultAuthProvider: 'openai', defaultAuthChoice: 'profile:work', defaultModel: 'openai/gpt-5.5' };
const codexMaterial = { provider: 'openai-codex', authChoice: 'profile:work', payload: { apiMode: 'openai-codex-oauth', accessToken: 'synthetic' } };

describe('/run error codes', () => {
  test('each rejection carries a fixed machine-readable code', async () => {
    const fetchWorker = worker();
    const cases: Array<[unknown, number, string]> = [
      ['{"route":', 400, 'invalid_request'],
      [{ route: codexRoute }, 400, 'invalid_request'],
      [{ route: codexRoute, material: { ...codexMaterial, authChoice: 'profile:other' } }, 400, 'route_mismatch'],
      [{ route: codexRoute, material: { ...codexMaterial, payload: { apiMode: 'openai-codex-oauth' } } }, 400, 'credential_missing'],
      [{ route: { ...codexRoute, defaultModel: 'openai/not-in-omp' }, material: codexMaterial }, 422, 'unsupported_model'],
      [{
        route: { defaultAuthProvider: 'custom', defaultAuthChoice: 'cloud-api-key:test', defaultModel: 'custom/demo' },
        material: { provider: 'custom', authChoice: 'cloud-api-key:test', payload: { apiKey: 'synthetic', baseUrl: 'http://127.0.0.1:1234/v1' } },
      }, 422, 'invalid_custom_endpoint'],
    ];
    for (const [body, status, error] of cases) {
      expect(await failure(await fetchWorker(post('/run', body)))).toEqual({ status, body: { error } });
    }
  });
});

describe('/validate-key', () => {
  test('a malformed or unsupported key is a 422 with its own code', async () => {
    const fetchWorker = worker();
    expect(await failure(await fetchWorker(post('/validate-key', { provider: 'groq', apiKey: '   ' }))))
      .toEqual({ status: 422, body: { error: 'invalid_api_key' } });
    expect(await failure(await fetchWorker(post('/validate-key', { provider: 'bedrock-mantle', apiKey: 'synthetic' }))))
      .toEqual({ status: 422, body: { error: 'unsupported_auth_method' } });
    expect(await failure(await fetchWorker(post('/validate-key', { provider: 'groq' }))))
      .toEqual({ status: 400, body: { error: 'invalid_request' } });
  });

  test('a key the provider rejects is a 4xx; a provider outage stays 502', async () => {
    const status = { value: 401 };
    const { seen } = network(() => Response.json({ error: { message: 'synthetic failure' } }, { status: status.value }));
    const fetchWorker = worker();
    const rejected = await fetchWorker(post('/validate-key', { provider: 'xai', apiKey: 'synthetic-rejected-key' }));
    const text = await rejected.text();
    expect([rejected.status, JSON.parse(text)]).toEqual([422, { error: 'api_key_rejected' }]);
    expect(text).not.toContain('synthetic-rejected-key');
    status.value = 503;
    expect(await failure(await fetchWorker(post('/validate-key', { provider: 'xai', apiKey: 'synthetic-key' }))))
      .toEqual({ status: 502, body: { error: 'provider_unavailable' } });
    expect(seen.map((request) => request.url)).toEqual(['https://api.x.ai/v1/models', 'https://api.x.ai/v1/models']);
  });

  test('verified is true only when the provider probe accepted the key', async () => {
    const status = { value: 200 };
    network(() => Response.json({}, { status: status.value }));
    expect(await validateHostedApiKey('nvidia', 'synthetic-key')).toEqual({ verified: true, apiKey: 'synthetic-key' });
    // nvidia's probe is optional: OMP accepts the key when the endpoint is down, but it was not verified.
    status.value = 503;
    expect(await validateHostedApiKey('nvidia', 'synthetic-key')).toEqual({ verified: false, apiKey: 'synthetic-key' });
    // Env-only providers have no probe.
    expect(await validateHostedApiKey('groq', 'synthetic-key')).toEqual({ verified: false, apiKey: 'synthetic-key' });
  });
});

describe('shared accepts-key rule', () => {
  test('catalog, login start, and validate-key agree for every provider', async () => {
    const catalog = bundledProviderCatalog();
    for (const provider of catalog) {
      expect([provider.id, provider.auth.acceptsApiKey]).toEqual([provider.id, provider.login.acceptsApiKeyMethod]);
      if (provider.login.kind === 'env-only') {
        expect([provider.id, provider.auth.kind]).toEqual([provider.id, provider.login.acceptsApiKeyMethod ? 'api-key' : 'native']);
      }
    }
    const sessions = manager(ompLoginRegistry(validateHostedApiKey));
    for (const provider of catalog.filter((row) => !row.login.acceptsApiKeyMethod)) {
      const start = await handleLoginRoute(new Request('http://worker/login/start', {
        method: 'POST',
        body: JSON.stringify({ provider: provider.id, sessionId: crypto.randomUUID(), method: 'api-key' }),
      }), sessions);
      expect([provider.id, start.status]).toEqual([provider.id, 422]);
      await expect(validateHostedApiKey(provider.id, 'synthetic-key')).rejects.toThrow('unsupported_auth_method');
    }
    const kinds = Object.fromEntries(catalog.map((row) => [row.id, [row.auth.kind, row.auth.acceptsApiKey]]));
    for (const id of ['bedrock-mantle', 'google-vertex', 'local', 'web', 'minimax-cn']) expect(kinds[id]).toEqual(['native', false]);
    expect(kinds.mistral).toEqual(['api-key', true]);
    sessions.close();
  });
});
