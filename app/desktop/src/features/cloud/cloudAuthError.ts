export type CloudAuthErrorCode =
  | 'invalid_email'
  | 'email_verification_required'
  | 'invalid_verification_code'
  | 'email_delivery_unavailable'
  | 'email_missing'
  | 'email_already_verified'
  | 'weak_password'
  | 'email_in_use'
  | 'invalid_credentials'
  | 'invalid_avatar'
  | 'invalid_avatar_seed'
  | 'invalid_avatar_version'
  | 'avatar_conflict'
  | 'invalid_session'
  | 'invalid_session_id'
  | 'invalid_attachment'
  | 'invalid_provider_auth_snapshot'
  | 'provider_auth_not_configured'
  | 'provider_auth_snapshot_not_found'
  | 'oauth_not_configured'
  | 'oauth_email_requires_sign_in'
  | 'requester_mismatch'
  | 'agent_not_available'
  | 'owner_online'
  | 'rate_limited'
  | 'account_missing'
  | 'invalid_account_id'
  | 'invalid_pubkey'
  | 'self_contact'
  | 'invalid_group_invitation'
  | 'group_invitation_expired'
  | 'group_invitation_full'
  | 'group_invitation_permission_denied'
  | 'group_invitation_missing'
  | 'self_group_invitation'
  | 'wrong_group_invitation_account'
  | 'server_error'
  | 'network_error'
  | 'plan_card_revision_conflict'
  | 'omp_unavailable'
  | 'unknown';

export class CloudAuthError extends Error {
  readonly code: CloudAuthErrorCode;
  readonly status: number;
  /** Seconds the server asked the client to wait, from a 429 Retry-After header. */
  readonly retryAfterSeconds?: number;

  constructor(code: CloudAuthErrorCode, message: string, status: number, retryAfterSeconds?: number) {
    super(message);
    this.code = code;
    this.status = status;
    if (retryAfterSeconds !== undefined) this.retryAfterSeconds = retryAfterSeconds;
    this.name = 'CloudAuthError';
  }
}

/** Reads a Retry-After header given as delta seconds or an HTTP date. */
export function parseRetryAfterSeconds(value: string | null | undefined, now = Date.now()): number | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  if (/^\d+$/.test(text)) return Number(text);
  const at = Date.parse(text);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, Math.ceil((at - now) / 1000));
}

export function isRetryableCloudDeliveryError(error: unknown): boolean {
  const status = error instanceof CloudAuthError ? error.status : null;
  return status === null
    || status === 0
    || status === 401
    || status === 429
    || status >= 500;
}

type ServerErrorBody = {
  errorCode?: string;
  message?: string;
  error?: { code?: string; message?: string };
};

const SERVER_ERROR_CODES = new Set<CloudAuthErrorCode>([
  'email_verification_required', 'invalid_verification_code', 'email_delivery_unavailable',
  'email_missing', 'email_already_verified',
  'invalid_email', 'weak_password', 'email_in_use', 'invalid_credentials',
  'invalid_avatar', 'invalid_avatar_seed', 'invalid_avatar_version', 'avatar_conflict',
  'invalid_session', 'invalid_session_id',
  'invalid_attachment', 'invalid_provider_auth_snapshot', 'provider_auth_not_configured',
  'provider_auth_snapshot_not_found', 'oauth_not_configured', 'oauth_email_requires_sign_in',
  'requester_mismatch',
  'agent_not_available', 'owner_online', 'rate_limited', 'account_missing',
  'invalid_account_id', 'invalid_pubkey', 'self_contact', 'invalid_group_invitation',
  'group_invitation_expired', 'group_invitation_full', 'group_invitation_permission_denied',
  'group_invitation_missing', 'self_group_invitation', 'wrong_group_invitation_account',
  'server_error', 'plan_card_revision_conflict', 'omp_unavailable',
]);

function isErrorCode(value: unknown): value is CloudAuthErrorCode {
  return typeof value === 'string' && SERVER_ERROR_CODES.has(value as CloudAuthErrorCode);
}

/** Converts an error returned through the OAuth callback fragment. */
export function cloudOAuthCallbackError(code: string | null, message: string): CloudAuthError {
  return new CloudAuthError(isErrorCode(code) ? code : 'unknown', message, 0);
}

export function buildCloudAuthError(
  status: number,
  body: unknown,
  fallbackMessage: string,
  retryAfter?: string | null,
): CloudAuthError {
  const data = (body as ServerErrorBody) ?? {};
  const codeValue = data.errorCode ?? data.error?.code;
  const messageValue = data.message ?? data.error?.message;
  const code = isErrorCode(codeValue) ? codeValue : 'unknown';
  const message = typeof messageValue === 'string' && messageValue.length > 0
    ? messageValue
    : fallbackMessage;
  return new CloudAuthError(code, message, status, parseRetryAfterSeconds(retryAfter));
}
