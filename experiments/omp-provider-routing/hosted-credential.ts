/**
 * Builds the API key OMP's transport expects from claimed provider material.
 *
 * Most providers take the access token or key as a bearer string. Providers whose
 * OMP auth policy declares `api-key-format "structured"` (Google Gemini CLI,
 * Antigravity, GitHub Copilot, Alibaba Coding Plan) parse a JSON credential at request
 * time instead; OMP builds it in `getOAuthApiKey`, which this module calls directly
 * so the shape always matches the pinned OMP version.
 */
import { getOAuthApiKey, type OAuthCredentials, type OAuthProvider } from '@oh-my-pi/pi-ai';
import * as AIError from '@oh-my-pi/pi-ai/error';
import { NEVER_EXPIRES } from '@oh-my-pi/pi-ai/registry/engine/common';
import { authPolicyFor } from '@oh-my-pi/pi-catalog/compat/auth';
import type { ProviderMaterial } from './worker';

type Payload = ProviderMaterial['payload'];

function optional(value: string | null | undefined): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

/** The OAuth credential OMP stores for this material; a missing expiry is OMP's "never expires". */
function oauthCredentials(payload: Payload & { accessToken: string }): OAuthCredentials {
  return {
    access: payload.accessToken,
    refresh: payload.refreshToken ?? '',
    expires: typeof payload.expiresAtMs === 'number' ? payload.expiresAtMs : NEVER_EXPIRES,
    projectId: optional(payload.projectId),
    enterpriseUrl: optional(payload.enterpriseUrl),
    apiEndpoint: optional(payload.apiEndpoint),
    accountId: optional(payload.accountId),
    email: optional(payload.email),
  };
}

/**
 * The key to hand to OMP for `ompProvider`, or `undefined` when the material has no
 * credential. Rejects with `credential_expired` when a structured credential has
 * already expired (OMP refuses to build a key from it).
 */
export async function hostedCredential(ompProvider: string, payload: Payload): Promise<string | undefined> {
  if (payload.apiMode === 'openai-codex-oauth') return optional(payload.accessToken);
  const accessToken = optional(payload.accessToken);
  if (accessToken && authPolicyFor(ompProvider)?.apiKeyFormat === 'structured') {
    try {
      const built = await getOAuthApiKey(ompProvider as OAuthProvider, {
        [ompProvider]: oauthCredentials({ ...payload, accessToken }),
      });
      return built?.apiKey;
    } catch (error) {
      if (error instanceof AIError.OAuthError) throw new Error('credential_expired');
      throw error;
    }
  }
  return optional(payload.apiKey) ?? accessToken;
}
