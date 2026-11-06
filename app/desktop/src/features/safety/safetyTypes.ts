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

/** `POST /v1/cloud/reports` body. The server copies message content from the ids. */
export type CloudReportInput = {
  clientReportId: string;
  reason: CloudReportReason;
  details?: string;
  reportedAccountId?: string;
  conversationId?: string;
  messageIds?: string[];
  contactRequestId?: string;
  alsoBlock?: boolean;
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

export type CloudReportResult = {
  report: CloudReportReceipt;
  /** True when the server also blocked the reported account. */
  blocked: boolean;
};

/** A person a block or unblock is about. */
export type SafetyAccountTarget = {
  accountId: string;
  name: string;
};

/** What a report is about: an account, or one message in a chat. */
export type ReportTarget = {
  /** Omitted when the server should infer it from the messages. */
  accountId: string | null;
  name: string;
  /** Chat sync v2 conversation id, or the session id the desktop knows the chat by. */
  conversationId?: string | null;
  messageIds?: string[];
};
