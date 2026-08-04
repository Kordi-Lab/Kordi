import type { CloudAuthClient } from './authClient';

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
