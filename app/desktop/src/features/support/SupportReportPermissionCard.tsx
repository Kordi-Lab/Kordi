import { useContext, useMemo, useState } from 'react';
import {
  CheckCircle2,
  CircleAlert,
  Flag,
  LoaderCircle,
  Send,
  ShieldCheck,
} from 'lucide-react';

import {
  buildSupportTicketInput,
  supportProposalSubmissionId,
  type SupportReportProposal,
} from '@/features/support/supportReport';
import {
  SupportReportSubmissionContext,
  useSupportReportSubmission,
} from '@/features/support/supportReportSubmission';

function categoryLabel(category: SupportReportProposal['draft']['category']) {
  if (category === 'question') return 'Question';
  if (category === 'feedback') return 'Feedback';
  return 'Issue';
}

export function SupportReportPermissionCard({
  proposal,
}: {
  proposal: SupportReportProposal;
}) {
  const [declined, setDeclined] = useState(false);
  const submissionContext = useContext(SupportReportSubmissionContext);
  const clientSubmissionId = useMemo(
    () => submissionContext
      ? supportProposalSubmissionId(submissionContext.sessionId, proposal.draft)
      : '',
    [proposal.draft, submissionContext],
  );
  const submission = useSupportReportSubmission(clientSubmissionId);
  const state = submission?.state;

  if (!submission || !state) return null;

  const approve = async () => {
    if (state.stage === 'sending' || state.stage === 'sent') return;
    try {
      await submission.submit(buildSupportTicketInput({
        draft: proposal.draft,
        sessionId: submission.sessionId,
        permissionGranted: true,
        clientSubmissionId,
      }));
    } catch {
      // The account-scoped submission store exposes the retryable error.
    }
  };

  return (
    <section
      className="mt-3 overflow-hidden rounded-[14px] border border-[color:var(--app-divider)] bg-[color:var(--app-main-muted-bg)]"
      aria-labelledby={`support-report-permission-${clientSubmissionId}`}
      data-support-report-permission-card="true"
    >
      <div className="flex min-w-0 items-start gap-2.5 px-3 py-2.5">
        <ShieldCheck
          className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--utility-muted-text)]"
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-start justify-between gap-3">
            <div className="min-w-0">
              <h3
                id={`support-report-permission-${clientSubmissionId}`}
                className="text-[12px] font-semibold leading-4 text-[color:var(--utility-foreground)]"
              >
                Send this to Kordi maintainers?
              </h3>
              <p className="mt-0.5 line-clamp-2 break-words text-[11px] leading-4 text-[color:var(--utility-muted-text)]">
                {proposal.draft.subject}
              </p>
            </div>
            <span className="shrink-0 text-[10px] font-medium leading-4 text-[color:var(--utility-muted-text)]">
              {categoryLabel(proposal.draft.category)}
            </span>
          </div>

          {state.stage === 'checking' ? (
            <div className="mt-2 flex min-w-0 items-center gap-2" aria-live="polite">
              <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin text-[color:var(--utility-muted-text)]" aria-hidden="true" />
              <p className="min-w-0 text-[10px] leading-4 text-[color:var(--utility-muted-text)]">
                Checking submission status…
              </p>
            </div>
          ) : state.stage === 'lookup-error' ? (
            <div className="mt-2" role="alert">
              <div className="flex items-start gap-1.5 text-[10px] leading-4 text-[color:var(--app-transient-danger-text)]">
                <CircleAlert className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
                <span>{state.message}</span>
              </div>
              <div className="mt-2.5 flex justify-end">
                <button
                  type="button"
                  className="app-button-quiet rounded-[8px] px-2.5 py-1 text-[10px] font-medium"
                  onClick={submission.retryLookup}
                >
                  Retry status
                </button>
              </div>
            </div>
          ) : !declined && (state.stage === 'pending' || state.stage === 'sending' || state.stage === 'error') ? (
            <>
              <p className="mt-2 text-[10px] leading-4 text-[color:var(--utility-muted-text)]">
                Approval sends only this draft, your signed-in account identity, and this support-session reference. Chat history, files, diagnostics, and provider credentials stay private.
              </p>
              {state.stage === 'error' ? (
                <div
                  className="mt-2 flex items-start gap-1.5 text-[10px] leading-4 text-[color:var(--app-transient-danger-text)]"
                  role="alert"
                >
                  <CircleAlert className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
                  <span>{state.message}</span>
                </div>
              ) : null}
              <div className="mt-2.5 flex flex-wrap items-center justify-end gap-1.5">
                <button
                  type="button"
                  className="app-button-quiet rounded-[8px] px-2.5 py-1 text-[10px] font-medium"
                  onClick={() => setDeclined(true)}
                  disabled={state.stage === 'sending'}
                >
                  Decline
                </button>
                <button
                  type="button"
                  className="app-button-primary inline-flex items-center rounded-[8px] px-2.5 py-1 text-[10px] font-semibold disabled:cursor-not-allowed disabled:opacity-55"
                  onClick={() => { void approve(); }}
                  disabled={state.stage === 'sending'}
                >
                  {state.stage === 'sending' ? (
                    <LoaderCircle className="mr-1.5 h-3 w-3 animate-spin" aria-hidden="true" />
                  ) : (
                    <Send className="mr-1.5 h-3 w-3" aria-hidden="true" />
                  )}
                  {state.stage === 'sending' ? 'Sending…' : 'Approve and send'}
                </button>
              </div>
            </>
          ) : state.stage === 'sent' ? (
            <div className="mt-2 flex min-w-0 items-center gap-2" aria-live="polite">
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" aria-hidden="true" />
              <p className="min-w-0 text-[10px] leading-4 text-[color:var(--utility-muted-text)]">
                Sent to Kordi maintainers. Reference: <span className="break-all font-medium text-[color:var(--utility-foreground)]">{state.ticketId}</span>
              </p>
            </div>
          ) : (
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2" aria-live="polite">
              <p className="inline-flex items-center gap-1.5 text-[10px] leading-4 text-[color:var(--utility-muted-text)]">
                <Flag className="h-3 w-3" aria-hidden="true" />
                Not sent.
              </p>
              <button
                type="button"
                className="app-button-quiet rounded-[8px] px-2 py-1 text-[10px] font-medium"
                onClick={() => setDeclined(false)}
              >
                Review again
              </button>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
