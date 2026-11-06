import { CloudAuthError } from '@/features/cloud/authClient';

/** Short copy for a failed block, unblock, or report. */
export function safetyErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof CloudAuthError)) return fallback;
  switch (error.code) {
    case 'invalid_session':
      return 'Sign in again to continue.';
    case 'rate_limited':
      return 'Too many reports. Try again later.';
    case 'self_block':
      return "You can't block yourself.";
    case 'cannot_block_service':
      return "Kordi accounts can't be blocked.";
    case 'self_report':
      return "You can't report yourself.";
    case 'account_missing':
      return 'This account no longer exists.';
    case 'invalid_report_evidence':
    case 'report_too_large':
      return "This message can't be reported.";
    default:
      return fallback;
  }
}
