import type { CloudReportInput, CloudReportReason, ReportTarget } from './safetyTypes';

export const REPORT_REASONS: ReadonlyArray<{ value: CloudReportReason; label: string }> = [
  { value: 'spam', label: 'Spam' },
  { value: 'harassment', label: 'Harassment or hate' },
  { value: 'inappropriate', label: 'Sexual or violent content' },
  { value: 'other', label: 'Something else' },
];

export const REPORT_DETAILS_MAX_CHARS = 1000;

export function reportDialogTitle(target: ReportTarget): string {
  return (target.messageIds?.length ?? 0) > 0 ? 'Report message' : `Report ${target.name}`;
}

/** The request body. Only ids and the person's own words are sent. */
export function buildReportInput(
  target: ReportTarget,
  reason: CloudReportReason,
  details: string,
  alsoBlock: boolean,
  clientReportId: string,
): CloudReportInput {
  const messageIds = [...new Set((target.messageIds ?? []).map((id) => id.trim()).filter(Boolean))];
  const trimmedDetails = details.trim().slice(0, REPORT_DETAILS_MAX_CHARS);
  const conversationId = target.conversationId?.trim();
  return {
    clientReportId,
    reason,
    ...(trimmedDetails ? { details: trimmedDetails } : {}),
    ...(target.accountId ? { reportedAccountId: target.accountId } : {}),
    ...(messageIds.length > 0 && conversationId ? { conversationId, messageIds } : {}),
    ...(alsoBlock ? { alsoBlock: true } : {}),
  };
}

/**
 * The idempotency key for a send: a retry with the same choices reuses the
 * previous id so the server records one report; changed choices get a new id.
 */
export function nextReportAttempt(
  previous: { id: string; fingerprint: string } | null,
  fingerprint: string,
  newId: () => string = () => globalThis.crypto.randomUUID(),
): { id: string; fingerprint: string } {
  return previous?.fingerprint === fingerprint ? previous : { id: newId(), fingerprint };
}
