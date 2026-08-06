import type { CloudAuthError } from '@/features/cloud/authClient';

export const PASSWORD_MIN_LENGTH = 8;

export function cloudLoginErrorMessage(
  error: CloudAuthError,
  showDebugAuthDiagnostics: boolean,
): string {
  switch (error.code) {
    case 'invalid_email':
      return 'That email address looks malformed.';
    case 'weak_password':
      return `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
    case 'email_in_use':
      return 'An account with that email already exists. Try signing in instead.';
    case 'invalid_credentials':
      return 'Email or password is incorrect.';
    case 'rate_limited':
      return 'Too many attempts. Wait a moment, then try again.';
    case 'invalid_session':
    case 'account_missing':
      return 'Your session expired. Please sign in again.';
    case 'network_error':
      return 'Could not reach the cloud server. Check your connection and try again.';
    case 'server_error':
      return 'The server hit an unexpected error. Please try again.';
    case 'missing_avatar':
      return 'Upload an avatar to create your account.';
    case 'invalid_avatar':
      return 'Could not process that avatar. Try another image.';
    case 'oauth_not_configured':
      return showDebugAuthDiagnostics
        ? 'That social sign-in method is not available here. Use email and password.'
        : 'Could not start social sign-in. Please try again in a moment.';
    default:
      return error.message || 'Something went wrong.';
  }
}
