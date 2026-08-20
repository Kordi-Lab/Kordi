import type { CloudAuthErrorCode } from './authClient';

export type CloudFallbackClaimFailureDiagnostic = {
  errorCode: CloudAuthErrorCode;
  httpStatus: number | null;
  retryDisposition: 'retry' | 'terminal';
};

const cloudAuthErrorCodes = new Set<CloudAuthErrorCode>([
  'invalid_email',
  'weak_password',
  'email_in_use',
  'invalid_credentials',
  'invalid_avatar',
  'invalid_avatar_seed',
  'invalid_avatar_version',
  'avatar_conflict',
  'invalid_session',
  'invalid_session_id',
  'invalid_attachment',
  'invalid_provider_auth_snapshot',
  'provider_auth_not_configured',
  'provider_auth_snapshot_not_found',
  'oauth_not_configured',
  'requester_mismatch',
  'agent_not_available',
  'owner_online',
  'rate_limited',
  'account_missing',
  'invalid_account_id',
  'invalid_pubkey',
  'self_contact',
  'server_error',
  'network_error',
  'unknown',
]);

function cloudFallbackClaimErrorCode(error: unknown): CloudAuthErrorCode {
  const rawCode = typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code?: unknown }).code
    : null;
  const code = typeof rawCode === 'string'
    ? rawCode.trim().toLowerCase()
    : '';
  return cloudAuthErrorCodes.has(code as CloudAuthErrorCode)
    ? code as CloudAuthErrorCode
    : 'unknown';
}

export function cloudFallbackClaimErrorIsRetryable(error: unknown): boolean {
  const code = cloudFallbackClaimErrorCode(error);
  return code === 'network_error'
    || code === 'owner_online'
    || code === 'agent_not_available'
    || code === 'rate_limited'
    || code === 'server_error';
}

export function cloudFallbackClaimFailureDiagnostic(
  error: unknown,
): CloudFallbackClaimFailureDiagnostic {
  const rawStatus = typeof error === 'object'
    && error !== null
    && 'status' in error
    ? (error as { status?: unknown }).status
    : null;
  const httpStatus = typeof rawStatus === 'number'
    && Number.isInteger(rawStatus)
    && rawStatus >= 100
    && rawStatus <= 599
    ? rawStatus
    : null;
  return {
    errorCode: cloudFallbackClaimErrorCode(error),
    httpStatus,
    retryDisposition: cloudFallbackClaimErrorIsRetryable(error)
      ? 'retry'
      : 'terminal',
  };
}
