import { useEffect, useRef, useState } from 'react';
import { Check, CheckCircle2, Flag, LoaderCircle, ShieldCheck, X } from 'lucide-react';

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

type SupportCheckboxProps = {
  checked: boolean;
  disabled?: boolean;
  label: string;
  description?: string;
  onChange: (checked: boolean) => void;
};

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

function SupportCheckbox({
  checked,
  disabled = false,
  label,
  description,
  onChange,
}: SupportCheckboxProps) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5 text-[11px] has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-55">
      <span className="relative mt-0.5 grid h-4 w-4 shrink-0 place-items-center">
        <input
          type="checkbox"
          className="peer sr-only"
          checked={checked}
          onChange={(event) => {
            const nextChecked = event.currentTarget.checked;
            onChange(nextChecked);
          }}
          disabled={disabled}
        />
        <span
          className="grid h-4 w-4 place-items-center rounded-[5px] border border-[color:var(--app-transient-border)] bg-transparent text-transparent transition-colors peer-checked:border-[color:var(--app-sidebar-accent)] peer-checked:bg-[color:var(--app-sidebar-accent)] peer-checked:text-[color:var(--app-sidebar-accent-text)] peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[color:var(--app-transient-focus-ring)]"
          aria-hidden="true"
        >
          <Check className="h-3 w-3" strokeWidth={2.5} />
        </span>
      </span>
      <span className="min-w-0">
        <span className="block font-medium leading-4">{label}</span>
        {description ? (
          <span className="app-transient-muted block leading-4">{description}</span>
        ) : null}
      </span>
    </label>
  );
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
      className="w-[min(33rem,calc(100vw-1.5rem))] max-w-none overflow-hidden rounded-[18px] p-0"
    >
      <div className="flex max-h-[calc(100dvh-1.5rem)] min-h-0 flex-col">
        <header className="app-transient-divider flex shrink-0 items-start justify-between gap-4 border-b px-4 py-3">
          <div className="min-w-0">
            <AppDialogTitle id="support-report-title" className="text-[14px] leading-5">
              {stage === 'sent' ? 'Report received' : 'Send a report'}
            </AppDialogTitle>
            <AppDialogDescription id="support-report-description" className="mt-0.5 text-[11px] leading-4">
              {stage === 'draft'
                ? 'Describe the request first. Nothing is sent until you review and approve it.'
                : stage === 'sent'
                  ? 'Kordi Support can now follow up using your signed-in account email.'
                  : 'Review every item below, then choose whether to allow the report to be sent.'}
            </AppDialogDescription>
          </div>
          <button
            type="button"
            className="app-button-quiet grid h-7 w-7 shrink-0 place-items-center rounded-[9px]"
            onClick={onDismiss}
            disabled={busy}
            aria-label="Close support report"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </header>

        {stage === 'sent' ? (
          <div className="min-h-0 overflow-y-auto px-4 py-4">
            <div className="flex items-start gap-3">
              <CheckCircle2
                className="mt-0.5 h-5 w-5 shrink-0 text-emerald-500"
                aria-hidden="true"
              />
              <div className="min-w-0">
                <p className="text-[12px] font-medium">
                  Your report was saved and queued for delivery.
                </p>
                <p className="app-transient-muted mt-1 break-all text-[11px] leading-4">
                  Reference: {ticketId}
                </p>
              </div>
            </div>
            <AppDialogActions className="mt-5">
              <button
                type="button"
                className="app-transient-flat-action rounded-[9px] px-3 py-1.5 text-[11px] font-medium"
                onClick={onDismiss}
              >
                Done
              </button>
            </AppDialogActions>
          </div>
        ) : stage === 'draft' ? (
          <form
            className="flex min-h-0 flex-1 flex-col"
            onSubmit={(event) => {
              event.preventDefault();
              if (!canReview) return;
              setPermissionGranted(false);
              setError('');
              setStage('review');
            }}
          >
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
              <div className="grid gap-3">
                <label className="grid gap-1 text-[11px] font-medium">
                  Type
                  <select
                    value={draft.category}
                    onChange={(event) => {
                      const category = event.currentTarget.value as SupportReportDraft['category'];
                      setDraft((current) => ({ ...current, category }));
                    }}
                    className="h-9 w-full rounded-[9px] border border-[color:var(--app-transient-border)] bg-transparent px-3 text-[12px] outline-none focus:border-[color:var(--app-transient-focus-ring)]"
                  >
                    <option value="issue">Issue</option>
                    <option value="question">Question</option>
                    <option value="feedback">Feedback</option>
                  </select>
                </label>

                <label className="grid gap-1 text-[11px] font-medium">
                  Subject
                  <input
                    autoFocus
                    required
                    value={draft.subject}
                    onChange={(event) => {
                      const subject = event.currentTarget.value;
                      setDraft((current) => ({ ...current, subject }));
                    }}
                    maxLength={160}
                    placeholder="Brief summary"
                    className="h-9 w-full rounded-[9px] border border-[color:var(--app-transient-border)] bg-transparent px-3 text-[12px] outline-none placeholder:text-[color:var(--app-transient-disabled-text)] focus:border-[color:var(--app-transient-focus-ring)]"
                  />
                </label>

                <label className="grid gap-1 text-[11px] font-medium">
                  Details
                  <textarea
                    required
                    value={draft.description}
                    onChange={(event) => {
                      const description = event.currentTarget.value;
                      setDraft((current) => ({ ...current, description }));
                    }}
                    maxLength={12_000}
                    rows={5}
                    placeholder="What happened, what did you expect, and how can we reproduce it?"
                    className="min-h-24 w-full resize-y rounded-[9px] border border-[color:var(--app-transient-border)] bg-transparent px-3 py-2 text-[12px] leading-[1.45] outline-none placeholder:text-[color:var(--app-transient-disabled-text)] focus:border-[color:var(--app-transient-focus-ring)]"
                  />
                </label>

                <div className="app-transient-divider border-t pt-3">
                  <SupportCheckbox
                    checked={draft.includeDiagnostics}
                    onChange={(includeDiagnostics) => setDraft((current) => ({
                      ...current,
                      includeDiagnostics,
                    }))}
                    label="Include limited app diagnostics"
                    description="App version, desktop platform, and operating system label only."
                  />
                </div>
              </div>
            </div>

            <AppDialogActions className="app-transient-divider mt-0 shrink-0 border-t px-4 py-3">
              <button
                type="button"
                className="app-button-quiet app-support-report-action rounded-[9px] px-2.5 py-1"
                onClick={onDismiss}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="app-transient-flat-action app-support-report-action rounded-[9px] px-2.5 py-1 font-medium disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!canReview}
              >
                Review report
              </button>
            </AppDialogActions>
          </form>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
              <dl className="grid gap-3 text-[11px]">
                <div className="app-transient-divider grid grid-cols-[5.5rem_minmax(0,1fr)] gap-3 border-b pb-3">
                  <dt className="app-transient-muted">Type</dt>
                  <dd className="font-medium">{reportCategoryLabel(draft.category)}</dd>
                </div>
                <div className="app-transient-divider grid grid-cols-[5.5rem_minmax(0,1fr)] gap-3 border-b pb-3">
                  <dt className="app-transient-muted">Subject</dt>
                  <dd className="break-words font-medium">{draft.subject.trim()}</dd>
                </div>
                <div className="app-transient-divider grid grid-cols-[5.5rem_minmax(0,1fr)] gap-3 border-b pb-3">
                  <dt className="app-transient-muted">Details</dt>
                  <dd className="max-h-36 overflow-y-auto whitespace-pre-wrap break-words leading-4">
                    {draft.description.trim()}
                  </dd>
                </div>
                <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-3">
                  <dt className="app-transient-muted">Included</dt>
                  <dd className="leading-4">
                    Signed-in account identity, support session reference
                    {draft.includeDiagnostics ? ', and limited app diagnostics' : ''}.
                  </dd>
                </div>
              </dl>

              <div className="app-transient-muted mt-3.5 flex items-start gap-2.5 text-[10px] leading-4">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <p>
                  No chat transcript, files, provider credentials, or unrelated conversations are included.
                </p>
              </div>

              <div className="app-transient-divider mt-3.5 border-t pt-3">
                <SupportCheckbox
                  checked={permissionGranted}
                  onChange={setPermissionGranted}
                  disabled={busy}
                  label="I allow Kordi to send the report shown above to Kordi Support."
                />
              </div>

              <div className="app-error-text mt-3 min-h-4 text-[11px] leading-4" aria-live="polite">
                {error}
              </div>
            </div>

            <AppDialogActions className="app-transient-divider mt-0 shrink-0 border-t px-4 py-3">
              <button
                type="button"
                className="app-button-quiet app-support-report-action rounded-[9px] px-2.5 py-1"
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
                className="app-transient-flat-action app-support-report-action inline-flex items-center rounded-[9px] px-2.5 py-1 font-medium disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() => { void submit(); }}
                disabled={!permissionGranted || busy}
              >
                {busy ? (
                  <LoaderCircle className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Flag className="mr-2 h-4 w-4" aria-hidden="true" />
                )}
                {busy ? 'Sending…' : 'Allow and send'}
              </button>
            </AppDialogActions>
          </div>
        )}
      </div>
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
