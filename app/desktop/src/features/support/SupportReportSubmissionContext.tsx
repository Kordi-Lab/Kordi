import {
  useMemo,
  type ReactNode,
} from 'react';

import {
  SupportReportSubmissionContext,
  type SupportReportSubmission,
} from '@/features/support/supportReportSubmission';

export function SupportReportSubmissionProvider({
  accountId,
  sessionId,
  onSubmit,
  onLookup,
  children,
}: {
  accountId?: string;
  sessionId?: string;
  onSubmit?: SupportReportSubmission['onSubmit'];
  onLookup?: SupportReportSubmission['onLookup'];
  children: ReactNode;
}) {
  const value = useMemo<SupportReportSubmission | null>(
    () => accountId && sessionId && onSubmit && onLookup
      ? { accountId, sessionId, onSubmit, onLookup }
      : null,
    [accountId, onLookup, onSubmit, sessionId],
  );

  return (
    <SupportReportSubmissionContext.Provider value={value}>
      {children}
    </SupportReportSubmissionContext.Provider>
  );
}
