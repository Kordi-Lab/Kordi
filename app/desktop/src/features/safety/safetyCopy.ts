import { CloudAuthError } from '@/features/cloud/authClient';

/** The block dialog's explanation, one consequence per line. */
export const BLOCK_EXPLANATION = [
  "They won't be able to message or call you, send you contact requests, add you to groups, see when you're online, or use your agents.",
  "They'll be removed from your contacts, and any call between you ends. If you unblock them later, you'll need to connect again.",
  "In groups you're both in, you'll still see their messages, but you won't get notifications for them. You can leave those groups.",
  "Kordi doesn't tell them you blocked them, but they may notice that their messages and requests don't go through.",
  "Blocking doesn't send anything to Kordi. To tell us about a problem, choose Report.",
] as const;

/** True when retrying the same request later may succeed. */
export function isConnectionProblem(error: unknown): boolean {
  if (!(error instanceof CloudAuthError)) return true;
  return error.status === 0 || error.status >= 500;
}

/**
 * Copy for a failed safety action. Server messages for the new consent and
 * report codes are already written for people, so they are shown as sent;
 * connection problems and anything unexpected get the action's own copy.
 */
export function safetyErrorMessage(error: unknown, connectionMessage: string): string {
  if (!(error instanceof CloudAuthError) || isConnectionProblem(error)) return connectionMessage;
  switch (error.code) {
    case 'rate_limited':
      return "You've sent a lot of reports recently. Try again later.";
    case 'self_block':
      return "You can't block yourself.";
    case 'cannot_block_service':
      return "Kordi service accounts can't be blocked.";
    case 'self_report':
      return "You can't report yourself.";
    case 'report_conflict':
      return 'This report was already sent with different details.';
    case 'report_too_large':
      return 'The selected messages are too large to send together. Choose fewer messages.';
    case 'request_decided':
      return 'This request was already answered or withdrawn.';
    case 'contact_request_unavailable':
      return "You can't send a contact request to this account.";
    case 'blocked_account':
      return 'You blocked this account. Unblock it before sending a contact request.';
    case 'invalid_report':
    case 'invalid_report_evidence':
    case 'CHAT_RELATIONSHIP_REQUIRED':
      return error.message || connectionMessage;
    default:
      return connectionMessage;
  }
}
