import { useState } from 'react';

type ContactRequestActionState = 'idle' | 'sending' | 'sent' | 'error';
export function ContactRequestFailureNotice({
  detail,
  onRequestCollaborationContact,
}: {
  detail?: string | null;
  onRequestCollaborationContact: () => Promise<void> | void;
}) {
  const [state, setState] = useState<ContactRequestActionState>('idle');

  const handleRequestContact = async () => {
    if (state === 'sending' || state === 'sent') return;
    setState('sending');
    try {
      await onRequestCollaborationContact();
      setState('sent');
    } catch {
      setState('error');
    }
  };

  const buttonLabel = state === 'sending'
    ? 'Sending…'
    : state === 'sent'
      ? 'Request sent'
      : 'Send contact request';

  return (
    <div
      className="app-contact-request-failure-notice mt-1.5 inline-flex max-w-[min(100%,34rem)] items-center gap-2 rounded-full bg-white/[0.06] px-3 py-1.5 text-[11px] leading-none text-slate-300 shadow-sm"
      title={detail?.trim() || undefined}
    >
      <span>Message not delivered.</span>
      <button
        type="button"
        onClick={() => { void handleRequestContact(); }}
        disabled={state === 'sending' || state === 'sent'}
        className="rounded-full bg-white/10 px-2 py-0.5 text-[11px] font-semibold text-sky-200 transition hover:bg-white/15 hover:text-sky-100 disabled:cursor-default disabled:opacity-60"
      >
        {buttonLabel}
      </button>
      {state === 'error' ? (
        <span className="font-medium text-rose-300">Try again from Contacts.</span>
      ) : null}
    </div>
  );
}
