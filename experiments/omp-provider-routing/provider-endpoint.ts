/**
 * The endpoint a provider credential is used against: OMP's transport `api` kind and
 * its base URL. The hosted runner reads `baseUrl` from claimed material, so every
 * claim carries it; a runner must never have to guess a host for a credential.
 *
 * The default comes from OMP's own model rows (the provider's default bundled text
 * model). OMP templates such as `https://bedrock-mantle.{region}.api.aws/...` or a
 * non-https scheme yield `null`, never a guessed host. Some logins choose their own
 * endpoint (a custom base URL, a region, an enterprise domain); that endpoint is read
 * through OMP's own credential parsers and kept only when the outbound guard accepts
 * it (https on a public name that resolves only to public addresses).
 */
import type { OAuthCredentials } from '@oh-my-pi/pi-ai';
import { resolveGitHubCopilotBaseUrl } from '@oh-my-pi/pi-ai/providers/github-copilot-headers';
import { getBundledModel, getBundledModels, type GeneratedProvider } from '@oh-my-pi/pi-catalog';
import { providerEntry } from '@oh-my-pi/pi-catalog/compat/providers';
import { parseAlibabaTokenPlanCredential } from '@oh-my-pi/pi-catalog/wire/alibaba-token-plan';
import { parseCloudflareAiGatewayCredential } from '@oh-my-pi/pi-catalog/wire/cloudflare-ai-gateway';
import {
  assertPublicHost,
  isBlockedAddress,
  parseCustomEndpoint,
  systemResolver,
  type AddressPolicy,
  type HostResolver,
} from './custom-endpoint';

export type ProviderEndpoint = { baseUrl: string | null; api: string | null };

export const NO_ENDPOINT: ProviderEndpoint = Object.freeze({ baseUrl: null, api: null });

/** Test seams for the endpoint check; production uses the system resolver and `isBlockedAddress`. */
export type EndpointGuard = { resolver?: HostResolver; isBlocked?: AddressPolicy };

type ModelRow = { api?: string; baseUrl?: string; kind?: string };

function defaultModel(provider: string): ModelRow | undefined {
  const entry = providerEntry(provider);
  const preferred = entry && getBundledModel(provider as GeneratedProvider, entry.defaultModel) as ModelRow | undefined;
  if (preferred) return preferred;
  return (getBundledModels(provider as GeneratedProvider) as ModelRow[]).find((model) => !model.kind || model.kind === 'text');
}

/** A literal https URL without its trailing slash; templates and other schemes yield `null`. */
function literalHttpsUrl(value: string | undefined): string | null {
  if (!value || /[{}<>]/.test(value)) return null;
  try {
    return new URL(value).protocol === 'https:' ? value.replace(/\/+$/, '') : null;
  } catch {
    return null;
  }
}

/** OMP's default endpoint for a provider, from its default bundled text model. */
export function providerDefaultEndpoint(provider: string): ProviderEndpoint {
  const model = defaultModel(provider);
  return { baseUrl: literalHttpsUrl(model?.baseUrl), api: model?.api ?? null };
}

/**
 * The endpoint a login result selects, read the way OMP reads it at request time;
 * `undefined` when the result selects none.
 */
function chosenBaseUrl(provider: string, result: OAuthCredentials | string, model: ModelRow | undefined): string | undefined {
  if (typeof result === 'string') {
    if (provider === 'alibaba-token-plan') return parseAlibabaTokenPlanCredential(result)?.baseUrl;
    if (provider === 'cloudflare-ai-gateway') {
      const credential = parseCloudflareAiGatewayCredential(result);
      if (!credential?.accountId || !credential.gatewayId || !model?.baseUrl) return undefined;
      return model.baseUrl
        .replace('<account>', encodeURIComponent(credential.accountId))
        .replace('<gateway>', encodeURIComponent(credential.gatewayId));
    }
    return undefined;
  }
  // OMP's openai transport sends Alibaba Coding Plan requests to `enterpriseUrl`.
  if (provider === 'alibaba-coding-plan') return result.enterpriseUrl;
  if (provider === 'github-copilot') {
    const key = JSON.stringify({ token: result.access, enterpriseUrl: result.enterpriseUrl, apiEndpoint: result.apiEndpoint });
    return resolveGitHubCopilotBaseUrl(model?.baseUrl, key);
  }
  return undefined;
}

/**
 * Resolves the endpoint for a claimed login result. A login-chosen endpoint that the
 * guard refuses rejects with `CustomEndpointError`, so the login fails rather than
 * storing a credential for an internal address.
 */
export async function resolveLoginEndpoint(
  provider: string,
  result: OAuthCredentials | string,
  guard: EndpointGuard = {},
): Promise<ProviderEndpoint> {
  const model = defaultModel(provider);
  const fallback = { baseUrl: literalHttpsUrl(model?.baseUrl), api: model?.api ?? null };
  const chosen = chosenBaseUrl(provider, result, model);
  if (chosen === undefined || chosen.replace(/\/+$/, '') === fallback.baseUrl) return fallback;
  const url = parseCustomEndpoint(chosen);
  await assertPublicHost(url.hostname, guard.resolver ?? systemResolver, guard.isBlocked ?? isBlockedAddress);
  return { baseUrl: url.href.replace(/\/+$/, ''), api: fallback.api };
}
