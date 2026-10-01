import { useId, useRef, useState } from 'react';
import { CheckCircle2, LoaderCircle } from 'lucide-react';

import { AppDialog, AppDialogActions, AppDialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

import {
  buildReportInput,
  REPORT_DETAILS_MAX_CHARS,
  REPORT_PRIVACY_FOOTER,
  REPORT_REASONS,
  reportDialogTitle,
  reportMessageSummary,
  reportReasonLabel,
} from './reportReasons';
import { safetyErrorMessage } from './safetyCopy';
import type { CloudReportInput, CloudReportReason, CloudReportReceipt, ReportTarget } from './safetyTypes';

type ReportDialogProps = {
  target: ReportTarget;
  onDismiss: () => void;
  onSubmit: (input: CloudReportInput) => Promise<CloudReportReceipt>;
  /** Present when the reported account is known and not blocked yet. */
  onBlock?: () => Promise<void>;
};

type Stage = 'draft' | 'sending' | 'sent';

export function ReportDialog({ target, onDismiss, onSubmit, onBlock }: ReportDialogProps) {
  const titleId = useId();
  const reasonGroupId = useId();
  const reasonHintId = useId();
  const detailsId = useId();
  const counterId = useId();
  const [reason, setReason] = useState<CloudReportReason | null>(null);
  const [details, setDetails] = useState('');
  const [alsoBlock, setAlsoBlock] = useState(false);
  const [stage, setStage] = useState<Stage>('draft');
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState<CloudReportReceipt | null>(null);
  const [blockOutcome, setBlockOutcome] = useState('');
  // A retry with the same choices reuses the id so the server sees one report.
  const attemptRef = useRef<{ id: string; fingerprint: string } | null>(null);
  const messageCount = new Set(target.messageIds ?? []).size;
  const name = target.name;

  const submit = async () => {
    if (!reason || stage !== 'draft') return;
    const fingerprint = JSON.stringify([reason, details.trim()]);
    const attempt = attemptRef.current?.fingerprint === fingerprint
      ? attemptRef.current
      : { id: globalThis.crypto.randomUUID(), fingerprint };
    attemptRef.current = attempt;
    setStage('sending');
    setError('');
    try {
      const result = await onSubmit(buildReportInput(target, reason, details, attempt.id));
      setReceipt(result);
      if (alsoBlock && onBlock) {
        try {
          await onBlock();
          setBlockOutcome(`${name} is blocked.`);
        } catch (caught) {
          setBlockOutcome(safetyErrorMessage(caught, `Couldn't block ${name}. Check your connection and try again.`));
        }
      }
      setStage('sent');
    } catch (caught) {
      setStage('draft');
      setError(safetyErrorMessage(caught, "Couldn't send your report. Your selections are kept. Try again."));
    }
  };

  if (stage === 'sent' && receipt) {
    return (
      <AppDialog titleId={titleId} onDismiss={onDismiss} className="max-w-[440px]">
        <div role="status" aria-live="polite">
          <AppDialogTitle id={titleId} className="flex items-center gap-2">
            <CheckCircle2 className="h-5 w-5 text-emerald-500" aria-hidden="true" />
            Report sent
          </AppDialogTitle>
          <p className="mt-2 mb-0 text-[13px] leading-6">
            {`Reference ${receipt.reference}. Thanks for telling us.`}
          </p>
          {blockOutcome ? <p className="mt-1 mb-0 text-[13px] leading-6">{blockOutcome}</p> : null}
        </div>
        <AppDialogActions>
          <Button type="button" onClick={onDismiss} autoFocus>Done</Button>
        </AppDialogActions>
      </AppDialog>
    );
  }

  const sending = stage === 'sending';
  return (
    <AppDialog
      titleId={titleId}
      onDismiss={onDismiss}
      dismissDisabled={sending}
      busy={sending}
      className="max-h-[calc(100vh-2rem)] max-w-[480px] overflow-y-auto"
    >
      <AppDialogTitle id={titleId}>{reportDialogTitle(name, messageCount)}</AppDialogTitle>
      <form
        className="mt-3 grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <fieldset id={reasonGroupId} className="m-0 grid gap-1.5 border-0 p-0" disabled={sending}>
          <legend className="mb-1.5 p-0 text-[13px] font-semibold">What&apos;s happening?</legend>
          {REPORT_REASONS.map((item) => (
            <label key={item.value} className="flex min-h-7 cursor-pointer items-center gap-2.5 text-[13px] leading-5">
              <input
                type="radio"
                name={`${reasonGroupId}-reason`}
                value={item.value}
                checked={reason === item.value}
                onChange={() => setReason(item.value)}
              />
              {item.label}
            </label>
          ))}
        </fieldset>

        <p className="m-0 text-[12px] leading-5 text-[color:var(--utility-muted-text)]">
          {reportMessageSummary(messageCount)}
        </p>

        <div className="grid gap-1.5">
          <label htmlFor={detailsId} className="text-[13px] font-semibold">
            Anything else we should know? (optional)
          </label>
          <textarea
            id={detailsId}
            value={details}
            maxLength={REPORT_DETAILS_MAX_CHARS}
            rows={3}
            disabled={sending}
            aria-describedby={counterId}
            onChange={(event) => setDetails(event.currentTarget.value.slice(0, REPORT_DETAILS_MAX_CHARS))}
            className="app-input-shell min-h-[4.5rem] resize-y rounded-[12px] px-3 py-2 text-[13px] leading-5 outline-none focus-visible:ring-2"
          />
          <span id={counterId} className="text-right text-[11px] text-[color:var(--utility-muted-text)]">
            {`${REPORT_DETAILS_MAX_CHARS - details.length} characters left`}
          </span>
        </div>

        {onBlock ? (
          <label className="flex min-h-7 cursor-pointer items-center gap-2.5 text-[13px] leading-5">
            <input
              type="checkbox"
              checked={alsoBlock}
              disabled={sending}
              onChange={(event) => setAlsoBlock(event.currentTarget.checked)}
            />
            {`Also block ${name}`}
          </label>
        ) : null}

        <p className="m-0 text-[11.5px] leading-5 text-[color:var(--utility-muted-text)]">{REPORT_PRIVACY_FOOTER}</p>

        <p aria-live="polite" className="app-error-text m-0 min-h-4 text-[12px] leading-5 text-[color:var(--app-transient-danger-text)]">
          {error}
        </p>
        <p id={reasonHintId} className="sr-only">
          {reason ? `Reason: ${reportReasonLabel(reason)}` : 'Choose a reason to send your report.'}
        </p>

        <AppDialogActions className="mt-0">
          <Button type="button" variant="secondary" onClick={onDismiss} disabled={sending}>Cancel</Button>
          <Button type="submit" disabled={!reason || sending} aria-describedby={reasonHintId}>
            {sending ? <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : null}
            Send report
          </Button>
        </AppDialogActions>
      </form>
    </AppDialog>
  );
}
