import { useState } from 'react';

import { ErrorLine } from '@/components/ui/ErrorLine';

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
    <ErrorLine
      className="app-contact-request-failure-notice max-w-[min(100%,34rem)]"
      align="center"
      role="status"
      action={{
        label: buttonLabel,
        onClick: () => { void handleRequestContact(); },
        disabled: state === 'sending' || state === 'sent',
      }}
    >
      <span title={detail?.trim() || undefined}>
        {state === 'error' ? 'Message not delivered. Try again from Contacts.' : 'Message not delivered.'}
      </span>
    </ErrorLine>
  );
}
