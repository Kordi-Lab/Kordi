import { getBundledProviders } from '@oh-my-pi/pi-catalog';
import { authPolicyFor } from '@oh-my-pi/pi-catalog/compat/auth';
import { providerEntry } from '@oh-my-pi/pi-catalog/compat/providers';
import { getProviderDefinition } from '@oh-my-pi/pi-ai';

/**
 * How a provider signs in. `env-only` means OMP declares no login rule; OMP reads an
 * API key from the environment, so hosted Kordi accepts a pasted key instead.
 */
export type ProviderLoginKind = 'api-key' | 'oauth-code' | 'device-code' | 'custom' | 'env-only';

/**
 * Display-safe projection of OMP's compiled login policy for one provider. It carries
 * only what a client needs to present the provider's own sign-in steps. It never
 * copies client IDs, client secrets, token or refresh endpoints, credential maps, or
 * userinfo settings from the compiled rule.
 */
export type ProviderLoginPolicy = {
  kind: ProviderLoginKind;
  name: string;
  /** Provider instructions; device-code text keeps the literal `{user_code}` placeholder. */
  instructions: string | null;
  prompt: string | null;
  placeholder: string | null;
  /** API-key console page, for `api-key` logins only. */
  authUrl: string | null;
  /** The `api-key` login probes the provider before accepting the key. */
  validates: boolean;
  /** The `oauth-code` login also accepts a pasted API key instead of a code. */
  pasteKey: boolean;
  /** The `oauth-code` login never listens for a loopback callback. */
  manualOnly: boolean;
  callbackPort: number | null;
  /** Path of the `oauth-code` loopback callback (such as `/auth/callback`); `null` for manual-only or other kinds. */
  callbackPath: string | null;
  /** OMP hook that implements a `custom` login. */
  hook: string | null;
  apiKeyFormat: 'bearer' | 'structured' | null;
  envVars: string[];
  /** Provider ID the resulting credential is stored under, when it differs from the login ID. */
  storeCredentialsAs: string | null;
  /** The provider takes a pasted API key through Kordi's api-key method; see `acceptsHostedApiKey`. */
  acceptsApiKeyMethod: boolean;
};

/**
 * Login-only OMP providers that the bundled model-provider list omits but that add
 * accounts for a listed provider (the Codex device sign-in stores `openai-codex`).
 */
export const LOGIN_ONLY_PROVIDER_IDS: readonly string[] = ['openai-codex-device'];

let bundledIds: Set<string> | undefined;

function isBundledProvider(id: string): boolean {
  bundledIds ??= new Set(getBundledProviders());
  return bundledIds.has(id);
}

/**
 * The single "accepts an API key" rule. The worker's `/login/start`, `/validate-key`,
 * and the published catalog (`login.acceptsApiKeyMethod`, `auth.acceptsApiKey`, and
 * `auth.kind`) all derive from it.
 *
 * - `api-key` logins always take a key.
 * - `env-only` providers take one when OMP names an env var for it, unless the
 *   provider transport authenticates natively (AWS credential chains for Bedrock),
 *   which a pasted key cannot drive in hosted mode.
 * - `oauth-code`, `device-code`, and `custom` logins take one when the login accepts
 *   a pasted key or OMP reads a `*_API_KEY` env var.
 */
export function acceptsHostedApiKey(
  policy: Pick<ProviderLoginPolicy, 'kind' | 'envVars' | 'pasteKey'>,
  nativeAuth: boolean,
): boolean {
  if (policy.kind === 'api-key') return true;
  if (policy.kind === 'env-only') return policy.envVars.length > 0 && !nativeAuth;
  return policy.pasteKey || policy.envVars.some((name) => name.endsWith('_API_KEY'));
}

/** Catalog `auth.kind`: the login kind, with `env-only` shown as `api-key` or `native` by the shared rule. */
export function catalogAuthKind(policy: ProviderLoginPolicy): 'api-key' | 'oauth-code' | 'device-code' | 'custom' | 'native' {
  if (policy.kind !== 'env-only') return policy.kind;
  return policy.acceptsApiKeyMethod ? 'api-key' : 'native';
}

/** Returns the login policy for an OMP provider, or `undefined` when OMP does not know the ID. */
export function providerLoginPolicy(id: string): ProviderLoginPolicy | undefined {
  const projected = projectLoginPolicy(id);
  const nativeAuth = !!authPolicyFor(id)?.nativeAuthApis?.length;
  return projected && { ...projected, acceptsApiKeyMethod: acceptsHostedApiKey(projected, nativeAuth) };
}

function projectLoginPolicy(id: string): ProviderLoginPolicy | undefined {
  const policy = authPolicyFor(id);
  const definition = getProviderDefinition(id);
  const entry = providerEntry(id);
  if (!policy && !definition && !entry && !isBundledProvider(id)) return undefined;

  const login = policy?.login;
  const envVars = entry?.envVars ?? (policy?.env && 'vars' in policy.env ? policy.env.vars : []);
  const base: ProviderLoginPolicy = {
    kind: login?.kind ?? 'env-only',
    name: policy?.name ?? definition?.name ?? id,
    instructions: null,
    prompt: null,
    placeholder: null,
    authUrl: null,
    validates: false,
    pasteKey: false,
    manualOnly: false,
    callbackPort: null,
    callbackPath: null,
    hook: null,
    apiKeyFormat: policy?.apiKeyFormat ?? null,
    envVars: [...envVars],
    storeCredentialsAs: definition?.storeCredentialsAs ?? policy?.storeAs ?? null,
    acceptsApiKeyMethod: false,
  };

  switch (login?.kind) {
    case 'api-key':
      return {
        ...base,
        instructions: login.instructions ?? null,
        prompt: login.prompt ?? null,
        placeholder: login.placeholder ?? null,
        authUrl: login.authUrl ?? null,
        validates: login.validate !== undefined,
      };
    case 'oauth-code':
      return {
        ...base,
        instructions: login.instructions ?? null,
        pasteKey: login.pasteKey !== undefined,
        manualOnly: login.callback.manualOnly,
        callbackPort: login.callback.port ?? null,
        callbackPath: login.callback.manualOnly ? null : login.callback.path || null,
      };
    case 'device-code':
      return { ...base, instructions: login.instructions ?? null };
    case 'custom':
      return { ...base, hook: login.hook };
    default:
      return base;
  }
}
