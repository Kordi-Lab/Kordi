export type CloudContactSummary = {
  contactId?: string | null;
  contactKind?: string | null;
  accountId: string;
  kordiId?: string | null;
  displayName: string | null;
  subtitle?: string | null;
  avatarUrl: string | null;
  nodeId: string | null;
  createdAt: string;
  locked?: boolean;
  targetCloudAgentId?: string | null;
  targetCloudAgentName?: string | null;
  targetCloudAgentOwnerAccountId?: string | null;
  targetCloudAgentOwnerName?: string | null;
  supportTicketEnabled?: boolean;
};

export function cloudContactSummaryKey(
  contact: Pick<CloudContactSummary, 'contactId' | 'accountId'>,
): string {
  return contact.contactId?.trim() || `account:${contact.accountId}`;
}
