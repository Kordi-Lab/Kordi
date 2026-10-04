/** An account the signed-in person blocked. The list is private to them. */
export type CloudBlockedAccount = {
  accountId: string;
  kordiId: string;
  displayName: string | null;
  avatarUrl: string | null;
  blockedAt: string;
};

export type CloudBlockResult = {
  block: CloudBlockedAccount;
  /** Whether the block ended an accepted contact relationship. */
  removedContact: boolean;
};

export type CloudReportReason =
  | 'spam'
  | 'harassment'
  | 'scam'
  | 'impersonation'
  | 'inappropriate'
  | 'other';

/** `POST /v1/cloud/reports` body. Evidence is built by the server from ids. */
export type CloudReportInput = {
  clientReportId: string;
  reason: CloudReportReason;
  details?: string;
  reportedAccountId?: string;
  conversationId?: string;
  messageIds?: string[];
  contactRequestId?: string;
};

export type CloudReportReceipt = {
  reportId: string;
  reference: string;
  status: 'received' | 'closed';
  reason: CloudReportReason;
  targetKind: 'account' | 'message';
  evidenceMessageCount: number;
  reportedDisplayName: string | null;
  createdAt: string;
  closedAt: string | null;
};

export type CloudLeaveConversationResult = {
  leftConversationIds: string[];
  successorAccountId: string | null;
};

/** A person a block, unblock, or account report is about. */
export type SafetyAccountTarget = {
  accountId: string;
  name: string;
};

/** What a report dialog is about: an account, or messages in one chat. */
export type ReportTarget = {
  /** Omitted when the server should infer it from the selected messages. */
  accountId: string | null;
  name: string;
  /** Cloud conversation id, or the session id the server knows it by. */
  conversationId?: string | null;
  messageIds?: string[];
  contactRequestId?: string | null;
};
