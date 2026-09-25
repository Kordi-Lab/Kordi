/**
 * Shared vocabulary of hosted OMP login sessions: steps, snapshots, claim material,
 * the registry seam, fixed error classifications, and HTTP-level rejections.
 */
import type { OAuthController, OAuthCredentials } from '@oh-my-pi/pi-ai';
import * as AIError from '@oh-my-pi/pi-ai/error';
import { CustomEndpointError } from './custom-endpoint';
import type { ProviderLoginPolicy } from './login-policy';
import { NO_ENDPOINT, type ProviderEndpoint } from './provider-endpoint';

export type LoginStatus = 'running' | 'awaiting-input' | 'completed' | 'failed' | 'cancelled';

/** Fixed, non-sensitive failure classifications. */
export type LoginErrorCode = 'provider_rejected' | 'timeout' | 'unsupported_flow' | 'invalid_input' | 'login_failed';

export type OpenUrlStep = { type: 'open-url'; url: string; launchUrl: string | null; instructions: string | null };

export type LoginStep =
  | { type: 'api-key'; instructions: string | null; prompt: string | null; placeholder: string | null; authUrl: string | null }
  | OpenUrlStep
  | { type: 'prompt'; message: string; placeholder: string | null; secret: boolean; allowEmpty: boolean }
  | { type: 'paste-code'; instructions: string }
  | { type: 'progress'; message: string };

export type LoginSnapshot = {
  sessionId: string;
  status: LoginStatus;
  /** Latest step emitted by the flow. */
  step: LoginStep | null;
  /** Latest `open-url` step, kept so a later progress or paste-code step does not hide the link or user code. */
  auth: OpenUrlStep | null;
  error: LoginErrorCode | null;
  /** Increments on every state change; pass it back as `after` when long-polling. */
  version: number;
};

/**
 * The credential the hosted server stores for a claim. Both shapes end with the
 * provider endpoint: `baseUrl` and OMP's transport `api` kind, so the runner sends the
 * credential to its own provider. `null` means OMP has no literal https endpoint for
 * the provider, and a runner must refuse rather than guess a host.
 */
export type LoginMaterial =
  | ({ apiMode: 'api-key'; apiKey: string } & ProviderEndpoint)
  | ({
    apiMode: string;
    accessToken: string;
    refreshToken: string | null;
    expiresAtMs: number | null;
    email: string | null;
    orgName: string | null;
    accountId: string | null;
    apiEndpoint: string | null;
    enterpriseUrl: string | null;
    projectId: string | null;
  } & ProviderEndpoint);

export type LoginClaim = { provider: string; material: LoginMaterial };

/** Seam between the session manager and OMP; tests inject fake providers here. */
export interface LoginRegistry {
  policy(provider: string): ProviderLoginPolicy | undefined;
  /** Runs the provider's own interactive login for `oauth-code`, `device-code`, and `custom` kinds. */
  login(provider: string, controller: OAuthController): Promise<OAuthCredentials | string>;
  /** Validates a pasted key for `api-key` and `env-only` kinds; resolves with the key to store. */
  validateApiKey(provider: string, apiKey: string, signal: AbortSignal): Promise<{ apiKey: string }>;
  /**
   * The endpoint the claimed credential is used against, for the provider it is
   * stored under. Rejects when a login-chosen endpoint fails the outbound guard.
   */
  endpoint(provider: string, result: OAuthCredentials | string): Promise<ProviderEndpoint>;
}

export type LoginSessionManagerOptions = {
  registry: LoginRegistry;
  now?: () => number;
  idleTimeoutMs?: number;
  maxSessions?: number;
  /** How long `start` waits for the flow's first step before answering. */
  firstStepWaitMs?: number;
};

/** A login failure with a fixed classification. */
export class HostedLoginError extends Error {
  constructor(readonly code: LoginErrorCode) {
    super(code);
    this.name = 'HostedLoginError';
  }
}

/** An HTTP-level rejection; `code` is a fixed string. */
export class LoginRouteError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
    this.name = 'LoginRouteError';
  }
}

/** Maps any login failure to a fixed classification without reading provider text. */
export function classifyLoginError(error: unknown): LoginErrorCode {
  if (error instanceof HostedLoginError) return error.code;
  const name = error && typeof error === 'object' && 'name' in error ? String(error.name) : '';
  if (name === 'AbortError' || name === 'TimeoutError') return 'timeout';
  if (!(error instanceof Error)) return 'login_failed';
  if (error.message === 'invalid_api_key' || error instanceof AIError.ApiKeyRequiredError
    || error instanceof CustomEndpointError) {
    return 'invalid_input';
  }
  if (error.message === 'unsupported_auth_method' || error instanceof AIError.OnPromptRequiredError
    || error instanceof AIError.ConfigurationError) {
    return 'unsupported_flow';
  }
  if (error instanceof AIError.LoginCancelledError) return 'timeout';
  if (error instanceof AIError.OAuthError) return error.kind === 'timeout' ? 'timeout' : 'provider_rejected';
  if (error instanceof AIError.ProviderHttpError) return 'provider_rejected';
  try {
    if (AIError.is(AIError.classify(error), AIError.Flag.AuthFailed)) return 'provider_rejected';
  } catch {
    // Classification is best effort; fall through to the generic code.
  }
  return 'login_failed';
}

/** Projects a login result and its endpoint onto the material envelope the hosted server stores. */
export function loginMaterial(
  result: OAuthCredentials | string,
  claimProvider: string,
  endpoint: ProviderEndpoint = NO_ENDPOINT,
): LoginMaterial {
  const { baseUrl, api } = endpoint;
  if (typeof result === 'string') return { apiMode: 'api-key', apiKey: result, baseUrl, api };
  return {
    apiMode: `${claimProvider}-oauth`,
    accessToken: result.access,
    refreshToken: result.refresh || null,
    expiresAtMs: Number.isFinite(result.expires) ? result.expires : null,
    email: result.email ?? null,
    orgName: result.orgName ?? null,
    accountId: result.accountId ?? null,
    apiEndpoint: result.apiEndpoint ?? null,
    enterpriseUrl: result.enterpriseUrl ?? null,
    projectId: result.projectId ?? null,
    baseUrl,
    api,
  };
}

/** A login result worth storing: a non-empty key or credentials with an access token. */
export function isUsableResult(result: unknown): result is OAuthCredentials | string {
  if (typeof result === 'string') return result.length > 0;
  return !!result && typeof result === 'object'
    && typeof (result as OAuthCredentials).access === 'string' && (result as OAuthCredentials).access.length > 0;
}
