import type {
  CloudSupportTicketCategory,
  CloudSupportTicketInput,
} from '@/features/cloud/supportClient';

export type SupportReportDraft = {
  category: CloudSupportTicketCategory;
  subject: string;
  description: string;
  includeDiagnostics: boolean;
};

export type SupportReportDiagnosticValues = {
  appVersion?: string;
  platform?: string;
  osVersion?: string;
};

type BuildSupportReportInput = {
  draft: SupportReportDraft;
  sessionId: string;
  permissionGranted: boolean;
  diagnostics?: SupportReportDiagnosticValues;
  clientSubmissionId: string;
};

export function buildSupportTicketInput({
  draft,
  sessionId,
  permissionGranted,
  diagnostics,
  clientSubmissionId,
}: BuildSupportReportInput): CloudSupportTicketInput {
  if (!permissionGranted) {
    throw new Error('Permission is required before sending this report.');
  }

  const subject = draft.subject.trim();
  const description = draft.description.trim();
  if (!subject || !description) {
    throw new Error('Add a subject and details before reviewing this report.');
  }

  return {
    category: draft.category,
    subject,
    description,
    sessionId: sessionId.trim() || undefined,
    diagnostics: draft.includeDiagnostics ? diagnostics : undefined,
    consent: {
      reportSubmission: true,
      diagnostics: draft.includeDiagnostics,
    },
    clientSubmissionId,
  };
}
