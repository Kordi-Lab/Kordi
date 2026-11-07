import { clientDistribution } from '@/features/cloud/distribution';
import type { CloudAuthError } from '@/features/cloud/authClient';
import { rateLimitedMessage } from '@/features/cloud/cloudAuthError';

export const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_RULE =
  `at least ${PASSWORD_MIN_LENGTH} characters, with an uppercase letter, a lowercase letter, and a number`;
export const PASSWORD_RULE_HINT = `Use ${PASSWORD_RULE}.`;

/** Mirrors the server sign-up policy; sign-in never checks it. */
export function passwordMeetsSignupRule(password: string): boolean {
  return [...password].length >= PASSWORD_MIN_LENGTH
    && /\p{Lu}/u.test(password)
    && /\p{Ll}/u.test(password)
    && /[0-9]/.test(password);
}

export function cloudLoginErrorMessage(
  error: CloudAuthError,
  showDebugAuthDiagnostics: boolean,
): string {
  switch (error.code) {
    case 'invalid_email':
      return 'That email address looks malformed.';
    case 'weak_password':
      return error.message || `Password must have ${PASSWORD_RULE}.`;
    case 'email_in_use':
      return 'An account with that email already exists. Try signing in instead.';
    case 'invalid_credentials':
      return 'Email or password is incorrect.';
    case 'email_already_verified':
      return error.message || 'This email is already verified.';
    case 'email_delivery_unavailable':
      return error.message || 'Email verification is temporarily unavailable. Try again later.';
    case 'email_missing':
      return error.message || 'This account has no email address to verify.';
    case 'rate_limited':
      return rateLimitedMessage(error);
    case 'invalid_session':
    case 'account_missing':
      return 'Your session expired. Please sign in again.';
    case 'network_error':
      return 'Could not reach the cloud server. Check your connection and try again.';
    case 'server_error':
      return 'The server hit an unexpected error. Please try again.';
    case 'invalid_avatar_seed':
      return 'Could not prepare that generated avatar. Try another look.';
    case 'invalid_avatar':
      return 'Could not process that avatar. Try another image.';
    case 'oauth_email_requires_sign_in':
      return error.message
        || 'A Kordi account already uses this email. Sign in with the method you used to create it.';
    case 'oauth_not_configured':
      return showDebugAuthDiagnostics
        ? 'That social sign-in method is not available here. Use email and password.'
        : 'Could not start social sign-in. Please try again in a moment.';
    default:
      return error.message || 'Something went wrong.';
  }
}

export function loginHeading(signup: boolean): string {
  const page = clientDistribution()?.loginPage;
  return (signup ? page?.signupTitle : page?.title) ?? (signup ? 'Create your account' : 'Welcome to Kordi');
}
export function loginSubtitle(signup: boolean): string {
  const page = clientDistribution()?.loginPage;
  return (signup ? page?.signupSubtitle : page?.subtitle) ?? (signup
    ? 'Sign up for Next-generation Supercollaboration' : 'Building Next-generation Supercollaboration');
}

/** The field a refused sign-in or sign-up names, so its border shows the error too. */
export function submitErrorField(error: CloudAuthError): 'email' | 'password' | null {
  if (error.code === 'invalid_email' || error.code === 'email_in_use') return 'email';
  if (error.code === 'invalid_credentials' || error.code === 'weak_password') return 'password';
  return null;
}
