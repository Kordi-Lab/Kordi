import { useId, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { ErrorLine } from '@/components/ui/ErrorLine';
import { AppDialog, AppDialogActions, AppDialogTitle } from '@/components/ui/dialog';
import { SettingsSwitch } from '@/kordi-app/components/settingsLayout';
import { cn } from '@/lib/utils';

import { SAFETY_DIALOG_BACKDROP_CLASS } from './BlockAccountDialog';
import { buildReportInput, nextReportAttempt, REPORT_DETAILS_MAX_CHARS, REPORT_REASONS, reportDialogTitle } from './reportReasons';
import { safetyErrorMessage } from './safetyCopy';
import type { CloudReportInput, CloudReportReason, ReportTarget } from './safetyTypes';

type ReportDialogProps = {
  target: ReportTarget;
  /** Shows "Also block <name>" when the reported account is known and not blocked yet. */
  canBlock: boolean;
  onSubmit: (input: CloudReportInput) => Promise<void>;
  onDismiss: () => void;
  /** Starting state, for previews. */
  initialStage?: 'draft' | 'sent';
};

export function ReportDialog({ target, canBlock, onSubmit, onDismiss, initialStage = 'draft' }: ReportDialogProps) {
  const titleId = useId();
  const reasonName = useId();
  const [reason, setReason] = useState<CloudReportReason | null>(null);
  const [details, setDetails] = useState('');
  const [alsoBlock, setAlsoBlock] = useState(false);
  const [stage, setStage] = useState<'draft' | 'sending' | 'sent'>(initialStage);
  const [error, setError] = useState('');
  // One clientReportId per open dialog and set of choices, reused on retry.
  const attemptRef = useRef<{ id: string; fingerprint: string } | null>(null);
  const name = target.name;
  const sending = stage === 'sending';

  const submit = async () => {
    if (!reason || stage !== 'draft') return;
    const block = canBlock && alsoBlock;
    const attempt = nextReportAttempt(attemptRef.current, JSON.stringify([reason, details.trim(), block]));
    attemptRef.current = attempt;
    setStage('sending');
    setError('');
    try {
      await onSubmit(buildReportInput(target, reason, details, block, attempt.id));
      setStage('sent');
    } catch (caught) {
      setStage('draft');
      setError(safetyErrorMessage(caught, "Couldn't send. Try again."));
    }
  };

  if (stage === 'sent') {
    return (
      <AppDialog titleId={titleId} onDismiss={onDismiss} className="max-w-md rounded-[20px]" backdropClassName={SAFETY_DIALOG_BACKDROP_CLASS}>
        <AppDialogTitle id={titleId} role="status">Report sent</AppDialogTitle>
        <AppDialogActions>
          <Button className="rounded-full px-4" autoFocus onClick={onDismiss}>Done</Button>
        </AppDialogActions>
      </AppDialog>
    );
  }

  return (
    <AppDialog
      titleId={titleId}
      onDismiss={onDismiss}
      dismissDisabled={sending}
      busy={sending}
      className="max-w-md rounded-[20px]"
      backdropClassName={SAFETY_DIALOG_BACKDROP_CLASS}
    >
      <AppDialogTitle id={titleId}>{reportDialogTitle(target)}</AppDialogTitle>
      <form
        className="mt-3 grid gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <fieldset className="m-0 grid gap-0.5 border-0 p-0" disabled={sending} aria-label="Reason">
          {REPORT_REASONS.map((item) => (
            <label
              key={item.value}
              className={cn(
                'app-transient-flat-action flex min-h-9 cursor-pointer items-center gap-2.5 rounded-[10px] px-2.5 text-[13px] leading-5',
                reason === item.value && 'app-transient-action-row',
              )}
            >
              <input
                type="radio"
                name={reasonName}
                value={item.value}
                checked={reason === item.value}
                onChange={() => setReason(item.value)}
              />
              {item.label}
            </label>
          ))}
        </fieldset>
        <textarea
          aria-label="Add details (optional)"
          placeholder="Add details (optional)"
          value={details}
          maxLength={REPORT_DETAILS_MAX_CHARS}
          rows={3}
          disabled={sending}
          onChange={(event) => setDetails(event.currentTarget.value.slice(0, REPORT_DETAILS_MAX_CHARS))}
          className="app-input-shell min-h-[4.5rem] resize-none rounded-[12px] px-3 py-2 text-[13px] leading-5 text-[color:var(--app-transient-text)] outline-none"
        />
        {canBlock ? (
          <div className="flex min-h-8 items-center justify-between gap-3 px-1 text-[13px] leading-5">
            <span>{`Also block ${name}`}</span>
            <SettingsSwitch enabled={alsoBlock} label={`Also block ${name}`} onChange={setAlsoBlock} disabled={sending} />
          </div>
        ) : null}
        {error ? (
          <ErrorLine className="mt-0">{error}</ErrorLine>
        ) : null}
        <AppDialogActions className="mt-2">
          <Button type="button" variant="quiet" className="rounded-full px-4" disabled={sending} onClick={onDismiss}>Cancel</Button>
          <Button type="submit" className="rounded-full px-4" disabled={!reason || sending}>Send</Button>
        </AppDialogActions>
      </form>
    </AppDialog>
  );
}
