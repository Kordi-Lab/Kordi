import { CloudAuthError, type CloudAuthClient } from './authClient';

export type CloudSupportTicketCategory = 'question' | 'issue' | 'feedback';

export type CloudSupportTicketInput = {
  category: CloudSupportTicketCategory;
  subject: string;
  description: string;
  sessionId?: string;
  diagnostics?: {
    appVersion?: string;
    platform?: string;
    osVersion?: string;
  };
  consent: {
    reportSubmission: true;
    diagnostics: boolean;
  };
  clientSubmissionId: string;
};

export type CloudSupportTicketResult = {
  ticketId: string;
  status: 'received';
  createdAt: string;
  created?: boolean;
  notificationStatus?: 'pending' | 'sending' | 'sent';
};

type CloudSupportTicketLookupResult = {
  ticket: CloudSupportTicketResult | null;
};

export function createCloudSupportTicket(
  client: CloudAuthClient,
  token: string,
  input: CloudSupportTicketInput,
): Promise<CloudSupportTicketResult> {
  return client.request<CloudSupportTicketResult>(
    '/v1/cloud/support/tickets',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(input),
    },
    'Could not submit your support request.',
  );
}

export async function getCloudSupportTicketBySubmissionId(
  client: CloudAuthClient,
  token: string,
  clientSubmissionId: string,
): Promise<CloudSupportTicketResult | null> {
  try {
    const result = await client.request<CloudSupportTicketLookupResult>(
      `/v1/cloud/support/tickets/by-submission/${encodeURIComponent(clientSubmissionId)}`,
      {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
      },
      'Could not restore the support request status.',
    );
    return result.ticket;
  } catch (caught) {
    // Older Cloud deployments do not expose the lookup route. POST remains
    // idempotent there, so treating a missing route as no known submission
    // preserves compatibility while the server rolls forward.
    if (caught instanceof CloudAuthError && caught.status === 404) return null;
    throw caught;
  }
}
