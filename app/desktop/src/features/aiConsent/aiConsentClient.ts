import { defaultCloudAuthClient, type CloudAuthClient } from '@/features/cloud/authClient';
import type { CloudAiConsent, CloudAiConsentStatus } from '@/features/cloud/cloudIdentityTypes';
import { loadSession } from '@/features/cloud/session';

export type { CloudAiConsent as AiConsent, CloudAiConsentStatus as AiConsentStatus } from '@/features/cloud/cloudIdentityTypes';

export const AI_CONSENT_PATH = '/v1/cloud/account/ai-consent';

export type AiConsentClient = {
  get(): Promise<CloudAiConsent>;
  put(status: Exclude<CloudAiConsentStatus, 'unset'>): Promise<CloudAiConsent>;
};

type TokenLoader = () => Promise<{ token: string } | null>;

export function isAiConsentStatus(value: unknown): value is CloudAiConsentStatus {
  return value === 'unset' || value === 'allowed' || value === 'declined';
}

function consentFromResponse(value: unknown): CloudAiConsent {
  const body = (value ?? {}) as { status?: unknown; decidedAt?: unknown };
  if (!isAiConsentStatus(body.status)) throw new Error('The server returned an unknown AI consent status.');
  return { status: body.status, decidedAt: typeof body.decidedAt === 'string' ? body.decidedAt : null };
}

/** `GET` and `PUT /v1/cloud/account/ai-consent` for the signed-in account. */
export function createAiConsentClient(
  client: Pick<CloudAuthClient, 'request'> = defaultCloudAuthClient(),
  session: TokenLoader = loadSession,
): AiConsentClient {
  const call = async (init: RequestInit, fallback: string) => {
    const stored = await session();
    if (!stored?.token) throw new Error('Sign in to Kordi first.');
    const headers = { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${stored.token}` };
    return consentFromResponse(await client.request<unknown>(AI_CONSENT_PATH, { ...init, headers }, fallback));
  };
  return {
    get: () => call({ method: 'GET' }, 'Could not load the AI setting.'),
    put: (status) => call(
      { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status }) },
      'Could not save the AI setting.',
    ),
  };
}
