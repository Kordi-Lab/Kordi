/**
 * Pasted API-key validation for the worker's `/validate-key` route and the login
 * `api-key` method. Whether a provider takes a key at all is decided by the shared
 * rule in login-policy.ts (`acceptsHostedApiKey`), the same one `/login/start` and the
 * published catalog use.
 */
import { getProviderDefinition } from '@oh-my-pi/pi-ai';
import * as AIError from '@oh-my-pi/pi-ai/error';
import { validateApiKeyAgainstModelsEndpoint } from '@oh-my-pi/pi-ai/registry/api-key-validation';
import { authPolicyFor } from '@oh-my-pi/pi-catalog/compat/auth';
import { CustomEndpointError } from './custom-endpoint';
import { providerLoginPolicy } from './login-policy';
import { workerFetch } from './outbound-guard';

const MAX_API_KEY_LENGTH = 16_384;
const VALIDATION_TIMEOUT_MS = 30_000;
/** OMP reports an optional probe it could not complete with this progress message. */
const SKIPPED_PROBE = /^Skipping .* validation endpoint/;

/**
 * `verified` is true only when a provider probe actually accepted the key. It is false
 * when OMP declares no probe, and when an optional probe could not run and OMP
 * accepted the key anyway. `apiKey` is the key as OMP normalized it; the HTTP route
 * never returns it.
 */
export type HostedKeyValidation = { verified: boolean; apiKey: string };

function boundedSignal(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(VALIDATION_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * Validates a pasted key. `api-key` logins run OMP's own login (including its probe).
 * Other providers that accept a key are probed only when OMP declares a paste-key
 * validation endpoint for a matching key; otherwise the key is accepted unverified.
 * Kordi's own `custom` provider is accepted here; its endpoint is checked on use.
 */
export async function validateHostedApiKey(provider: string, apiKey: string, signal?: AbortSignal): Promise<HostedKeyValidation> {
  const key = apiKey.trim();
  if (!key || key.length > MAX_API_KEY_LENGTH) throw new Error('invalid_api_key');
  if (provider === 'custom') return { verified: false, apiKey: key };
  const loginPolicy = providerLoginPolicy(provider);
  if (!loginPolicy?.acceptsApiKeyMethod) throw new Error('unsupported_auth_method');

  const rule = authPolicyFor(provider)?.login;
  if (rule?.kind === 'api-key') {
    let probeSkipped = false;
    const result = await getProviderDefinition(provider)?.login?.({
      onAuth: () => {},
      onPrompt: async () => key,
      onProgress: (message) => {
        if (SKIPPED_PROBE.test(String(message))) probeSkipped = true;
      },
      signal: boundedSignal(signal),
      fetch: workerFetch(),
    });
    if (typeof result !== 'string' || !result) throw new Error('invalid_api_key');
    return { verified: rule.validate !== undefined && !probeSkipped, apiKey: result };
  }
  const pasteKey = rule?.kind === 'oauth-code' ? rule.pasteKey : undefined;
  if (pasteKey && key.startsWith(pasteKey.prefix)) {
    await validateApiKeyAgainstModelsEndpoint({
      provider: loginPolicy.name,
      apiKey: key,
      modelsUrl: pasteKey.validateUrl,
      signal: boundedSignal(signal),
      fetch: workerFetch(),
    });
    return { verified: true, apiKey: key };
  }
  return { verified: false, apiKey: key };
}

/** A fixed `/validate-key` failure: 4xx for a key or provider the caller must change, 502 for an outage. */
export type KeyValidationFailure = { status: number; error: string };

/** Maps a `validateHostedApiKey` failure to a fixed code without reading provider text into the response. */
export function keyValidationFailure(error: unknown): KeyValidationFailure {
  if (error instanceof CustomEndpointError) return { status: 422, error: 'invalid_custom_endpoint' };
  if (error instanceof AIError.ApiKeyRequiredError || (error instanceof Error && error.message === 'invalid_api_key')) {
    return { status: 422, error: 'invalid_api_key' };
  }
  if (error instanceof Error && error.message === 'unsupported_auth_method') {
    return { status: 422, error: 'unsupported_auth_method' };
  }
  if (error instanceof AIError.ProviderHttpError && (error.status === 401 || error.status === 403)) {
    return { status: 422, error: 'api_key_rejected' };
  }
  try {
    if (AIError.is(AIError.classify(error), AIError.Flag.AuthFailed)) return { status: 422, error: 'api_key_rejected' };
  } catch {
    // Classification is best effort; anything else is treated as a provider outage.
  }
  return { status: 502, error: 'provider_unavailable' };
}
