import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Flag, LoaderCircle, ShieldCheck, X } from 'lucide-react';

import {
  AppDialog,
  AppDialogActions,
  AppDialogDescription,
  AppDialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import type {
  CloudSupportTicketInput,
  CloudSupportTicketResult,
} from '@/features/cloud/supportClient';
import {
  buildSupportTicketInput,
  type SupportReportDraft,
  type SupportReportDiagnosticValues,
} from '@/features/support/supportReport';

type SupportReportDialogProps = {
  sessionId: string;
  onDismiss: () => void;
  onSubmit: (input: CloudSupportTicketInput) => Promise<CloudSupportTicketResult>;
};

type SupportReportActionProps = {
  sessionId: string;
  onSubmit: (input: CloudSupportTicketInput) => Promise<CloudSupportTicketResult>;
};

type SupportReportStage = 'draft' | 'review' | 'sending' | 'sent';

const INITIAL_DRAFT: SupportReportDraft = {
  category: 'issue',
  subject: '',
  description: '',
  includeDiagnostics: false,
};

function clientSubmissionId() {
  const randomId = globalThis.crypto?.randomUUID?.();
  return `desktop:${randomId ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
}

async function loadDiagnosticValues(): Promise<SupportReportDiagnosticValues> {
  const platform = 'desktop';
  const osVersion = typeof navigator === 'undefined'
    ? undefined
    : navigator.platform?.trim() || undefined;
  if (typeof window === 'undefined' || !window.__TAURI_INTERNALS__) {
    return { platform, osVersion };
  }
  try {
    const { getVersion } = await import('@tauri-apps/api/app');
    return { appVersion: await getVersion(), platform, osVersion };
  } catch {
    return { platform, osVersion };
  }
}

function reportCategoryLabel(category: SupportReportDraft['category']) {
  if (category === 'question') return 'Question';
  if (category === 'feedback') return 'Feedback';
  return 'Issue';
}

export function SupportReportDialog({
  sessionId,
  onDismiss,
  onSubmit,
}: SupportReportDialogProps) {
  const [draft, setDraft] = useState<SupportReportDraft>(INITIAL_DRAFT);
  const [stage, setStage] = useState<SupportReportStage>('draft');
  const [permissionGranted, setPermissionGranted] = useState(false);
  const [diagnostics, setDiagnostics] = useState<SupportReportDiagnosticValues>({
    platform: 'desktop',
  });
  const [error, setError] = useState('');
  const [ticketId, setTicketId] = useState('');
  const submissionIdRef = useRef<string | null>(null);
  const canReview = Boolean(draft.subject.trim() && draft.description.trim());
  const busy = stage === 'sending';

  useEffect(() => {
    if (!draft.includeDiagnostics) return undefined;
    let active = true;
    void loadDiagnosticValues().then((values) => {
      if (active) setDiagnostics(values);
    });
    return () => {
      active = false;
    };
  }, [draft.includeDiagnostics]);

  const submit = async () => {
    if (!permissionGranted || busy) return;
    setStage('sending');
    setError('');
    submissionIdRef.current ??= clientSubmissionId();
    try {
      const result = await onSubmit(buildSupportTicketInput({
        draft,
        sessionId,
        permissionGranted,
        diagnostics,
        clientSubmissionId: submissionIdRef.current,
      }));
      setTicketId(result.ticketId);
      setStage('sent');
    } catch (caught) {
      setStage('review');
      setError(caught instanceof Error ? caught.message : 'Could not send this report. Try again.');
    }
  };

  return (
    <AppDialog
      titleId="support-report-title"
      descriptionId="support-report-description"
      onDismiss={onDismiss}
      dismissDisabled={busy}
      busy={busy}
      className="max-w-[520px] overflow-hidden rounded-[20px] p-0"
    >
      <header className="app-transient-divider flex items-start justify-between gap-4 border-b px-5 py-4">
        <div className="min-w-0">
          <AppDialogTitle id="support-report-title">
            {stage === 'sent' ? 'Report received' : 'Send a report'}
          </AppDialogTitle>
          <AppDialogDescription id="support-report-description" className="mt-1 leading-5">
            {stage === 'draft'
              ? 'Describe the request first. Nothing is sent until you review and approve it.'
              : stage === 'sent'
                ? 'Kordi Support can now follow up using your signed-in account email.'
                : 'Review every item below, then choose whether to allow the report to be sent.'}
          </AppDialogDescription>
        </div>
        <button
          type="button"
          className="app-button-quiet grid h-8 w-8 shrink-0 place-items-center rounded-[10px]"
          onClick={onDismiss}
          disabled={busy}
          aria-label="Close support report"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </header>

      {stage === 'sent' ? (
        <div className="px-5 py-6">
          <div className="flex items-start gap-3">
            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-500" aria-hidden="true" />
            <div>
              <p className="text-[13px] font-medium">Your report was saved and queued for delivery.</p>
              <p className="app-transient-muted mt-1 text-[12px] leading-5">Reference: {ticketId}</p>
            </div>
          </div>
          <AppDialogActions>
            <button
              type="button"
              className="app-transient-flat-action rounded-[10px] px-4 py-2 text-[12px] font-medium"
              onClick={onDismiss}
            >
              Done
            </button>
          </AppDialogActions>
        </div>
      ) : stage === 'draft' ? (
        <form
          className="px-5 py-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!canReview) return;
            setPermissionGranted(false);
            setError('');
            setStage('review');
          }}
        >
          <div className="grid gap-3.5">
            <label className="grid gap-1.5 text-[12px] font-medium">
              Type
              <select
                value={draft.category}
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  category: event.currentTarget.value as SupportReportDraft['category'],
                }))}
                className="h-10 w-full rounded-[10px] border border-[color:var(--app-transient-border)] bg-transparent px-3 text-[13px] outline-none focus:border-[color:var(--app-transient-focus-ring)]"
              >
                <option value="issue">Issue</option>
                <option value="question">Question</option>
                <option value="feedback">Feedback</option>
              </select>
            </label>
            <label className="grid gap-1.5 text-[12px] font-medium">
              Subject
              <input
                autoFocus
                value={draft.subject}
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  subject: event.currentTarget.value,
                }))}
                maxLength={160}
                placeholder="Brief summary"
                className="h-10 w-full rounded-[10px] border border-[color:var(--app-transient-border)] bg-transparent px-3 text-[13px] outline-none placeholder:text-[color:var(--app-transient-disabled-text)] focus:border-[color:var(--app-transient-focus-ring)]"
              />
            </label>
            <label className="grid gap-1.5 text-[12px] font-medium">
              Details
              <textarea
                value={draft.description}
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  description: event.currentTarget.value,
                }))}
                maxLength={12_000}
                rows={6}
                placeholder="What happened, what did you expect, and how can we reproduce it?"
                className="min-h-32 w-full resize-y rounded-[10px] border border-[color:var(--app-transient-border)] bg-transparent px-3 py-2.5 text-[13px] leading-5 outline-none placeholder:text-[color:var(--app-transient-disabled-text)] focus:border-[color:var(--app-transient-focus-ring)]"
              />
            </label>
            <label className="app-transient-row flex cursor-pointer items-start gap-3 rounded-[12px] px-3 py-2.5 text-[12px]">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 accent-[color:var(--app-sidebar-accent)]"
                checked={draft.includeDiagnostics}
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  includeDiagnostics: event.currentTarget.checked,
                }))}
              />
              <span>
                <span className="block font-medium">Include limited app diagnostics</span>
                <span className="app-transient-muted mt-0.5 block leading-4">
                  App version, desktop platform, and operating system label only.
                </span>
              </span>
            </label>
          </div>
          <AppDialogActions>
            <button type="button" className="app-button-quiet rounded-[10px] px-3 py-2 text-[12px]" onClick={onDismiss}>
              Cancel
            </button>
            <button
              type="submit"
              className="app-transient-flat-action rounded-[10px] px-4 py-2 text-[12px] font-medium disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!canReview}
            >
              Review report
            </button>
          </AppDialogActions>
        </form>
      ) : (
        <div className="px-5 py-4">
          <dl className="grid gap-3 text-[12px]">
            <div className="app-transient-divider grid grid-cols-[6.5rem_minmax(0,1fr)] gap-3 border-b pb-3">
              <dt className="app-transient-muted">Type</dt>
              <dd className="font-medium">{reportCategoryLabel(draft.category)}</dd>
            </div>
            <div className="app-transient-divider grid grid-cols-[6.5rem_minmax(0,1fr)] gap-3 border-b pb-3">
              <dt className="app-transient-muted">Subject</dt>
              <dd className="break-words font-medium">{draft.subject.trim()}</dd>
            </div>
            <div className="app-transient-divider grid grid-cols-[6.5rem_minmax(0,1fr)] gap-3 border-b pb-3">
              <dt className="app-transient-muted">Details</dt>
              <dd className="max-h-36 overflow-y-auto whitespace-pre-wrap break-words leading-5">{draft.description.trim()}</dd>
            </div>
            <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-3">
              <dt className="app-transient-muted">Included</dt>
              <dd className="leading-5">
                Signed-in account identity, support session reference
                {draft.includeDiagnostics ? ', and limited app diagnostics' : ''}.
              </dd>
            </div>
          </dl>

          <div className="app-transient-muted mt-4 flex items-start gap-2.5 text-[11px] leading-5">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <p>
              No chat transcript, files, provider credentials, or unrelated conversations are included.
            </p>
          </div>

          <label className="app-transient-row mt-4 flex cursor-pointer items-start gap-3 rounded-[12px] px-3 py-2.5 text-[12px]">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 accent-[color:var(--app-sidebar-accent)]"
              checked={permissionGranted}
              onChange={(event) => setPermissionGranted(event.currentTarget.checked)}
              disabled={busy}
            />
            <span className="font-medium leading-5">
              I allow Kordi to send the report shown above to Kordi Support.
            </span>
          </label>

          <div className="app-error-text mt-3 min-h-4 text-[11px] leading-4" aria-live="polite">
            {error}
          </div>
          <AppDialogActions className="mt-3">
            <button
              type="button"
              className="app-button-quiet rounded-[10px] px-3 py-2 text-[12px]"
              onClick={() => {
                setPermissionGranted(false);
                setError('');
                setStage('draft');
              }}
              disabled={busy}
            >
              Back
            </button>
            <button
              type="button"
              className="app-transient-flat-action inline-flex items-center rounded-[10px] px-4 py-2 text-[12px] font-medium disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => { void submit(); }}
              disabled={!permissionGranted || busy}
            >
              {busy ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : <Flag className="mr-2 h-4 w-4" aria-hidden="true" />}
              {busy ? 'Sending…' : 'Allow and send'}
            </button>
          </AppDialogActions>
        </div>
      )}
    </AppDialog>
  );
}

export function SupportReportAction({ sessionId, onSubmit }: SupportReportActionProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        type="button"
        variant="quiet"
        onClick={() => setOpen(true)}
        className="app-utility-button mt-0.5 h-8 rounded-[10px] px-2.5 text-[12px] font-medium"
      >
        <Flag className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
        Send report
      </Button>
      {open ? (
        <SupportReportDialog
          sessionId={sessionId}
          onSubmit={onSubmit}
          onDismiss={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

export function SupportConversationEmptyState() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center px-6 py-12 text-center">
      <ShieldCheck className="h-7 w-7 text-[color:var(--utility-muted-text)]" aria-hidden="true" />
      <h3 className="mt-3 text-[15px] font-semibold">Kordi Support</h3>
      <p className="app-transient-muted mt-1.5 text-[12px] leading-5">
        Ask a product question in this chat, or use Send report above to contact the Kordi team.
      </p>
    </div>
  );
}
