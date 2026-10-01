import type { CloudReportInput, CloudReportReason, ReportTarget } from './safetyTypes';

export const REPORT_REASONS: ReadonlyArray<{ value: CloudReportReason; label: string }> = [
  { value: 'spam', label: 'Spam' },
  { value: 'harassment', label: 'Harassment or bullying' },
  { value: 'scam', label: 'Scam or fraud' },
  { value: 'impersonation', label: 'Pretending to be someone else' },
  { value: 'inappropriate', label: 'Inappropriate or harmful content' },
  { value: 'other', label: 'Something else' },
];

export const REPORT_DETAILS_MAX_CHARS = 1000;
export const REPORT_MAX_MESSAGES = 50;

export function reportReasonLabel(reason: CloudReportReason): string {
  return REPORT_REASONS.find((item) => item.value === reason)?.label ?? 'Something else';
}

export function reportDialogTitle(name: string, messageCount: number): string {
  return messageCount > 0 ? `Report messages from ${name}` : `Report ${name}`;
}

export function reportMessageSummary(messageCount: number): string {
  if (messageCount <= 0) {
    return 'No messages are included. To include messages, choose Report on a message.';
  }
  const noun = messageCount === 1 ? 'message' : 'messages';
  return `${messageCount} ${noun} you selected. Only these messages are included, with details about any files attached to them. Nothing else from this chat is sent.`;
}

export const REPORT_PRIVACY_FOOTER = 'Your report goes to the Kordi team with your account name. '
  + 'We keep reports for up to 90 days after we close them. '
  + 'We may not be able to reply or tell you what we did.';

/** Builds the request body. Only ids and the person's own words are sent. */
export function buildReportInput(
  target: ReportTarget,
  reason: CloudReportReason,
  details: string,
  clientReportId: string,
): CloudReportInput {
  const messageIds = [...new Set(target.messageIds ?? [])];
  const trimmedDetails = details.trim();
  return {
    clientReportId,
    reason,
    ...(trimmedDetails ? { details: trimmedDetails } : {}),
    ...(target.accountId ? { reportedAccountId: target.accountId } : {}),
    ...(messageIds.length > 0 && target.conversationId
      ? { conversationId: target.conversationId, messageIds }
      : {}),
    ...(target.contactRequestId ? { contactRequestId: target.contactRequestId } : {}),
  };
}
