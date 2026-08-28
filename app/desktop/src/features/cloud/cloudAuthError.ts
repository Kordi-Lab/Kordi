export type CloudAuthErrorCode =
  | 'invalid_email'
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
  | 'unknown';

export class CloudAuthError extends Error {
  readonly code: CloudAuthErrorCode;
  readonly status: number;

  constructor(code: CloudAuthErrorCode, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
    this.name = 'CloudAuthError';
  }
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
  'invalid_email', 'weak_password', 'email_in_use', 'invalid_credentials',
  'invalid_avatar', 'invalid_avatar_seed', 'invalid_avatar_version', 'avatar_conflict',
  'invalid_session', 'invalid_session_id',
  'invalid_attachment', 'invalid_provider_auth_snapshot', 'provider_auth_not_configured',
  'provider_auth_snapshot_not_found', 'oauth_not_configured', 'requester_mismatch',
  'agent_not_available', 'owner_online', 'rate_limited', 'account_missing',
  'invalid_account_id', 'invalid_pubkey', 'self_contact', 'invalid_group_invitation',
  'group_invitation_expired', 'group_invitation_full', 'group_invitation_permission_denied',
  'group_invitation_missing', 'self_group_invitation', 'wrong_group_invitation_account',
  'server_error',
]);

function isErrorCode(value: unknown): value is CloudAuthErrorCode {
  return typeof value === 'string' && SERVER_ERROR_CODES.has(value as CloudAuthErrorCode);
}

export function buildCloudAuthError(
  status: number,
  body: unknown,
  fallbackMessage: string,
): CloudAuthError {
  const data = (body as ServerErrorBody) ?? {};
  const codeValue = data.errorCode ?? data.error?.code;
  const messageValue = data.message ?? data.error?.message;
  const code = isErrorCode(codeValue) ? codeValue : 'unknown';
  const message = typeof messageValue === 'string' && messageValue.length > 0
    ? messageValue
    : fallbackMessage;
  return new CloudAuthError(code, message, status);
}
