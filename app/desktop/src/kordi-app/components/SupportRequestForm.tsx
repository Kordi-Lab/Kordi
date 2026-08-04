import { useState } from 'react';
import { CheckCircle2, LoaderCircle, Send } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export type SupportRequestInput = {
  category: 'question' | 'issue' | 'feedback';
  subject: string;
  description: string;
  sessionId?: string;
  diagnostics?: { appVersion?: string; platform?: string; osVersion?: string };
  clientSubmissionId: string;
};

export type SupportRequestResult = {
  ticketId: string;
  status: string;
  createdAt: string;
};

type SupportRequestFormProps = {
  onSubmit: (input: SupportRequestInput) => Promise<SupportRequestResult>;
};

export function SupportRequestForm({ onSubmit }: SupportRequestFormProps) {
  const [category, setCategory] = useState<SupportRequestInput['category']>('question');
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [state, setState] = useState<'idle' | 'saving' | 'sent' | 'error'>('idle');
  const [error, setError] = useState('');
  const [ticketId, setTicketId] = useState('');
  const canSubmit = Boolean(subject.trim() && description.trim() && state !== 'saving');

  const submit = async () => {
    if (!canSubmit) return;
    setState('saving');
    setError('');
    try {
      const result = await onSubmit({
        category,
        subject: subject.trim(),
        description: description.trim(),
        diagnostics: { platform: 'desktop' },
        clientSubmissionId: `desktop:${crypto.randomUUID()}`,
      });
      setTicketId(result.ticketId);
      setState('sent');
      setSubject('');
      setDescription('');
    } catch (caught) {
      setState('error');
      setError(caught instanceof Error ? caught.message : 'Unable to submit your request.');
    }
  };

  return (
    <form
      className="mt-4 border-t border-[color:var(--app-transient-border)] pt-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="mb-3">
        <div className="text-[13px] font-medium">Submit a request</div>
        <div className="app-transient-muted mt-0.5 text-[11px] leading-4">
          Send a question, report a problem, or share feedback with the Kordi team.
        </div>
      </div>
      <div className="grid gap-2.5">
        <label className="grid gap-1 text-[11px] font-medium">
          Type
          <select
            value={category}
            onChange={(event) => {
              setCategory(event.currentTarget.value as SupportRequestInput['category']);
              setState('idle');
            }}
            className="h-9 w-full rounded-[10px] border border-[color:var(--app-transient-border)] bg-transparent px-3 text-[12px] outline-none focus:border-[color:var(--app-transient-focus-ring)]"
          >
            <option value="question">Question</option>
            <option value="issue">Issue</option>
            <option value="feedback">Feedback</option>
          </select>
        </label>
        <label className="grid gap-1 text-[11px] font-medium">
          Subject
          <input
            value={subject}
            onChange={(event) => {
              setSubject(event.currentTarget.value);
              setState('idle');
            }}
            maxLength={160}
            placeholder="Brief summary"
            className="h-9 w-full rounded-[10px] border border-[color:var(--app-transient-border)] bg-transparent px-3 text-[12px] outline-none placeholder:text-[color:var(--app-transient-disabled-text)] focus:border-[color:var(--app-transient-focus-ring)]"
          />
        </label>
        <label className="grid gap-1 text-[11px] font-medium">
          Details
          <textarea
            value={description}
            onChange={(event) => {
              setDescription(event.currentTarget.value);
              setState('idle');
            }}
            maxLength={12_000}
            rows={4}
            placeholder="What happened, or what would you like help with?"
            className="min-h-24 w-full resize-y rounded-[10px] border border-[color:var(--app-transient-border)] bg-transparent px-3 py-2 text-[12px] leading-5 outline-none placeholder:text-[color:var(--app-transient-disabled-text)] focus:border-[color:var(--app-transient-focus-ring)]"
          />
        </label>
        <Button
          type="submit"
          variant="secondary"
          className="app-transient-flat-action rounded-[10px]"
          disabled={!canSubmit}
        >
          {state === 'saving' ? (
            <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Send className="mr-2 h-4 w-4" />
          )}
          {state === 'saving' ? 'Sending…' : 'Send request'}
        </Button>
      </div>
      <div
        className={cn(
          'mt-2 min-h-4 text-[11px] leading-4',
          state === 'error' ? 'app-error-text' : 'app-transient-muted',
        )}
        aria-live="polite"
      >
        {state === 'error' ? error : null}
        {state === 'sent' ? (
          <span className="inline-flex items-center gap-1.5">
            <CheckCircle2 className="h-3.5 w-3.5" />
            Request received · {ticketId}
          </span>
        ) : null}
      </div>
    </form>
  );
}
