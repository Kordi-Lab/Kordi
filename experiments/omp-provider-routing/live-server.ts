import { createHash, timingSafeEqual } from 'node:crypto';
import { getBundledModel, getBundledModels, getBundledProviders, type GeneratedProvider } from '@oh-my-pi/pi-catalog';
import { authPolicyFor } from '@oh-my-pi/pi-catalog/compat/auth';
import { providerEntry } from '@oh-my-pi/pi-catalog/compat/providers';
import { getProviderDefinition, streamSimple, type Model } from '@oh-my-pi/pi-ai';
import {
  createPublicEndpointFetch,
  isBlockedAddress,
  resolvePublicEndpoint,
  systemResolver,
  type AddressPolicy,
  type EndpointFetch,
  type HostResolver,
} from './custom-endpoint';
import { keyValidationFailure, validateHostedApiKey } from './hosted-api-key';
import { hostedCredential } from './hosted-credential';
import { catalogAuthKind, LOGIN_ONLY_PROVIDER_IDS, providerLoginPolicy, type ProviderLoginPolicy } from './login-policy';
import { handleLoginRoute, LoginSessionManager, ompLoginRegistry } from './login-sessions';
import { installWorkerFetchGuard } from './outbound-guard';
import { providerDefaultEndpoint } from './provider-endpoint';
import type { HostedRoute, ProviderMaterial } from './worker';

export { validateHostedApiKey } from './hosted-api-key';

type RunRequest = { route: HostedRoute & { thinking?: string }; material: ProviderMaterial };

const MAX_BODY_LENGTH = 16_384;

/**
 * One provider row as served by `/catalog` and pinned in shared/omp-catalog.
 * `auth.kind` and `auth.acceptsApiKey` come from the same login policy the worker
 * enforces (login-policy.ts `acceptsHostedApiKey`). `baseUrl` and `api` are the
 * endpoint a claimed credential for this row is used against.
 */
export function providerCatalogRow(id: string) {
  const policy = authPolicyFor(id);
  const entry = providerEntry(id);
  const rule = policy?.login;
  // Every row is a bundled or login-only OMP provider, so the policy is always defined.
  const login = providerLoginPolicy(id) as ProviderLoginPolicy;
  const endpoint = providerDefaultEndpoint(login.storeCredentialsAs ?? id);
  return {
    id,
    defaultModel: entry?.defaultModel ?? null,
    baseUrl: endpoint.baseUrl,
    api: endpoint.api,
    auth: {
      kind: catalogAuthKind(login),
      name: policy?.name ?? id,
      acceptsApiKey: login.acceptsApiKeyMethod,
      instructions: rule?.kind === 'api-key' ? rule.instructions ?? null : null,
      authUrl: rule?.kind === 'api-key' ? rule.authUrl ?? null : null,
      placeholder: rule?.kind === 'api-key' ? rule.placeholder ?? null : null,
      envVars: entry?.envVars ?? [],
    },
    login,
    models: getBundledModels(id as GeneratedProvider)
      .filter((model) => !model.kind || model.kind === 'text')
      .map((model) => model.id),
  };
}

/**
 * OMP's bundled providers plus login-only providers (such as `openai-codex-device`)
 * that add accounts for a bundled provider but are absent from the bundled list.
 */
export function bundledProviderCatalog() {
  const bundled = new Set<string>(getBundledProviders());
  const loginOnly = LOGIN_ONLY_PROVIDER_IDS
    .filter((id) => !bundled.has(id) && !!getProviderDefinition(id)?.login);
  return [...bundled, ...loginOnly].map(providerCatalogRow);
}

let catalogBody: string | undefined;

/** The `/catalog` body. It derives only from the pinned dependency, so it is built once per process. */
export function catalogResponseBody(): string {
  catalogBody ??= JSON.stringify({ providers: bundledProviderCatalog() });
  return catalogBody;
}

function canonicalProvider(provider: string): string {
  if (provider === 'openai-codex' || provider === 'codex') return 'openai';
  if (provider === 'google-gemini') return 'google';
  return provider;
}

/** An OpenAI-compatible model on an endpoint already checked by `resolvePublicEndpoint`. */
function customModel(modelID: string, url: URL): Model<'openai-completions'> {
  return {
    id: modelID,
    name: modelID,
    api: 'openai-completions',
    provider: 'custom',
    baseUrl: url.toString().replace(/\/$/, ''),
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
}

/** Test seams for the Custom API route; production uses the system resolver, `isBlockedAddress`, and global fetch. */
export type LiveTurnDependencies = { resolveHost?: HostResolver; fetch?: EndpointFetch; isBlockedAddress?: AddressPolicy };

export async function runLiveHostedTurn({ route, material }: RunRequest, dependencies: LiveTurnDependencies = {}) {
  if (canonicalProvider(route.defaultAuthProvider) !== canonicalProvider(material.provider)
    || route.defaultAuthChoice !== material.authChoice) {
    throw new Error('route_mismatch');
  }
  const [modelProvider, ...modelParts] = route.defaultModel.split('/');
  const modelID = modelParts.join('/');
  if (canonicalProvider(modelProvider) !== canonicalProvider(material.provider) || !modelID) {
    throw new Error('route_mismatch');
  }
  const ompProvider = material.provider === 'codex' ? 'openai-codex'
    : material.provider === 'google-gemini' ? 'google' : material.provider;
  const credential = await hostedCredential(ompProvider, material.payload);
  if (!credential) throw new Error('credential_missing');
  const resolveHost = dependencies.resolveHost ?? systemResolver;
  const isBlocked = dependencies.isBlockedAddress ?? isBlockedAddress;
  const endpoint = ompProvider === 'custom'
    ? await resolvePublicEndpoint(material.payload.baseUrl, resolveHost, isBlocked)
    : undefined;
  const model = endpoint
    ? customModel(modelID, endpoint)
    : getBundledModel(ompProvider as GeneratedProvider, modelID);
  if (!model) throw new Error('unsupported_model');
  // The custom route re-resolves before every attempt and refuses redirects.
  const guardedFetch = endpoint
    ? createPublicEndpointFetch(endpoint, resolveHost, dependencies.fetch ?? globalThis.fetch, isBlocked)
    : undefined;
  const effort = route.thinking === 'max' ? 'xhigh' : route.thinking;
  const reasoning = effort && ['minimal', 'low', 'medium', 'high', 'xhigh'].includes(effort)
    ? effort as 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
    : undefined;
  const response = await streamSimple(model, {
    systemPrompt: ['Reply in one short sentence. Do not mention credentials or account details.'],
    messages: [{ role: 'user', content: 'Confirm that this model can answer a Kordi route test.' }],
    tools: [],
  }, {
    apiKey: credential,
    reasoning,
    signal: guardedFetch ? AbortSignal.any([guardedFetch.signal, AbortSignal.timeout(45_000)]) : AbortSignal.timeout(45_000),
    ...(guardedFetch ? { fetch: guardedFetch } : {}),
  }).result();
  if (guardedFetch?.blocked) throw new Error('invalid_custom_endpoint');
  if (response.stopReason === 'error') throw new Error('provider_rejected');
  const answer = response.content.find((block) => block.type === 'text')?.text?.trim();
  if (!answer) throw new Error('provider_rejected');
  return { provider: material.provider, model: modelID, response: answer.slice(0, 1_000) };
}

/** `/run` failures and their statuses; any other failure is `502 route_test_failed`. */
const RUN_FAILURES: ReadonlyMap<string, number> = new Map([
  ['route_mismatch', 400],
  ['credential_missing', 400],
  ['unsupported_model', 422],
  ['invalid_custom_endpoint', 422],
  ['credential_expired', 502],
  ['provider_rejected', 502],
]);

/** Maps a `runLiveHostedTurn` failure to a fixed status and machine-readable code. */
export function runFailure(error: unknown): { status: number; error: string } {
  const code = error instanceof Error ? error.message : '';
  const status = RUN_FAILURES.get(code);
  return status === undefined ? { status: 502, error: 'route_test_failed' } : { status, error: code };
}

/**
 * Checks the Authorization header against the worker bearer in constant time. Both
 * sides are hashed first so the comparison does not reveal the expected length.
 */
export function hasWorkerBearer(request: Request, token: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();
  return timingSafeEqual(digest(request.headers.get('authorization') ?? ''), digest(`Bearer ${token}`));
}

/** Every worker error body is `{error: <fixed code>}`. */
function errorResponse(status: number, error: string): Response {
  return Response.json({ error }, { status, headers: { 'cache-control': 'no-store' } });
}

function isRunRequest(input: unknown): input is RunRequest {
  const { route, material } = (input ?? {}) as Partial<RunRequest>;
  return typeof route?.defaultAuthProvider === 'string' && typeof route.defaultAuthChoice === 'string'
    && typeof route.defaultModel === 'string' && typeof material?.provider === 'string'
    && typeof material.authChoice === 'string' && !!material.payload && typeof material.payload === 'object';
}

async function handleValidateKey(input: unknown): Promise<Response> {
  const { provider, apiKey } = (input ?? {}) as { provider?: unknown; apiKey?: unknown };
  if (typeof provider !== 'string' || typeof apiKey !== 'string') return errorResponse(400, 'invalid_request');
  try {
    const { verified } = await validateHostedApiKey(provider, apiKey);
    return Response.json({ verified });
  } catch (error) {
    const failure = keyValidationFailure(error);
    return errorResponse(failure.status, failure.error);
  }
}

async function handleRun(input: unknown): Promise<Response> {
  if (!isRunRequest(input)) return errorResponse(400, 'invalid_request');
  try {
    return Response.json(await runLiveHostedTurn(input));
  } catch (error) {
    const failure = runFailure(error);
    return errorResponse(failure.status, failure.error);
  }
}

/** HTTP handler for the worker. Every route except `/health` and `/catalog` requires the bearer. */
export function createWorkerFetch(token: string, loginSessions: LoginSessionManager) {
  return async function fetch(request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (request.method === 'GET' && pathname === '/health') {
      return new Response('ok');
    }
    if (request.method === 'GET' && pathname === '/catalog') {
      return new Response(catalogResponseBody(), { headers: { 'content-type': 'application/json;charset=utf-8' } });
    }
    if (pathname === '/login' || pathname.startsWith('/login/')) {
      if (!hasWorkerBearer(request, token)) return errorResponse(401, 'unauthorized');
      return handleLoginRoute(request, loginSessions);
    }
    if (request.method !== 'POST' || !['/run', '/validate-key'].includes(pathname)) {
      return errorResponse(404, 'not_found');
    }
    if (!hasWorkerBearer(request, token)) return errorResponse(401, 'unauthorized');
    const body = await request.text();
    if (body.length > MAX_BODY_LENGTH) return errorResponse(413, 'request_too_large');
    let input: unknown;
    try {
      input = JSON.parse(body);
    } catch {
      return errorResponse(400, 'invalid_request');
    }
    return pathname === '/validate-key' ? handleValidateKey(input) : handleRun(input);
  };
}

if (import.meta.main) {
  const token = Bun.env.KORDI_OMP_ROUTE_WORKER_TOKEN;
  if (!token) throw new Error('OMP route worker token is required.');
  // Every outbound request from this process, including OMP's own logins and key
  // probes, goes through the resolve-and-block guard (outbound-guard.ts).
  installWorkerFetchGuard();
  const loginSessions = new LoginSessionManager({
    registry: ompLoginRegistry((provider, apiKey, signal) => validateHostedApiKey(provider, apiKey, signal)),
  });
  setInterval(() => loginSessions.sweep(), 30_000).unref();
  Bun.serve({
    // Production deployments must keep this worker on an internal network only; never expose it publicly.
    hostname: Bun.env.KORDI_OMP_ROUTE_WORKER_HOST || '127.0.0.1',
    port: Number(Bun.env.KORDI_OMP_ROUTE_WORKER_PORT ?? '17331'),
    // Login status requests long-poll for up to 30 seconds; Bun's default idle timeout is 10.
    idleTimeout: 60,
    fetch: createWorkerFetch(token, loginSessions),
  });
}
