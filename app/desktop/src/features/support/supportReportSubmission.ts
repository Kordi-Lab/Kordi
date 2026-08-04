import { createContext, useContext } from 'react';

import type {
  CloudSupportTicketInput,
  CloudSupportTicketResult,
} from '@/features/cloud/supportClient';

export type SupportReportSubmission = {
  sessionId: string;
  onSubmit: (input: CloudSupportTicketInput) => Promise<CloudSupportTicketResult>;
};

export const SupportReportSubmissionContext =
  createContext<SupportReportSubmission | null>(null);

export function useSupportReportSubmission() {
  return useContext(SupportReportSubmissionContext);
}
