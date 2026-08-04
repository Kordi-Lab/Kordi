import {
  useMemo,
  type ReactNode,
} from 'react';

import {
  SupportReportSubmissionContext,
  type SupportReportSubmission,
} from '@/features/support/supportReportSubmission';

export function SupportReportSubmissionProvider({
  sessionId,
  onSubmit,
  children,
}: {
  sessionId?: string;
  onSubmit?: SupportReportSubmission['onSubmit'];
  children: ReactNode;
}) {
  const value = useMemo<SupportReportSubmission | null>(
    () => sessionId && onSubmit ? { sessionId, onSubmit } : null,
    [onSubmit, sessionId],
  );

  return (
    <SupportReportSubmissionContext.Provider value={value}>
      {children}
    </SupportReportSubmissionContext.Provider>
  );
}
