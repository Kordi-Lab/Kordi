import { Button } from '@/components/ui/button';

import type { DirectConsentKind } from './directConversationConsent';

type DirectConversationConsentNoticeProps = {
  id: string;
  kind: Exclude<DirectConsentKind, 'contact'>;
  name: string;
  busy: boolean;
  error: string | null;
  onUnblock: () => void;
  onAccept: () => void;
  onDecline: () => void;
  onBlock: () => void;
  onSendRequest: () => void;
  onWithdraw: () => void;
};

function noticeText(kind: DirectConversationConsentNoticeProps['kind'], name: string): string {
  switch (kind) {
    case 'blocked':
      return `You blocked ${name}. Unblock them to send messages.`;
    case 'incoming':
      return `${name} wants to connect. Accept their request to reply.`;
    case 'outgoing':
      return `Your contact request is waiting for ${name} to accept.`;
    default:
      return `You and ${name} aren't contacts, so you can't send messages here.`;
  }
}

/** Explains why a direct chat is read-only and offers the next step. */
export function DirectConversationConsentNotice({
  id,
  kind,
  name,
  busy,
  error,
  onUnblock,
  onAccept,
  onDecline,
  onBlock,
  onSendRequest,
  onWithdraw,
}: DirectConversationConsentNoticeProps) {
  const action = (label: string, onClick: () => void, danger = false) => (
    <Button
      key={label}
      type="button"
      variant="secondary"
      size="sm"
      className={danger ? 'app-transient-flat-action-danger h-8 rounded-full px-3 text-[12px]' : 'h-8 rounded-full px-3 text-[12px]'}
      disabled={busy}
      onClick={onClick}
    >
      {label}
    </Button>
  );
  return (
    <div
      id={id}
      role="status"
      data-direct-consent-notice={kind}
      className="app-direct-consent-notice mb-2 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[16px] border border-[color:var(--app-control-border)] bg-[color:var(--app-control-bg)] px-3.5 py-2.5 text-[12.5px] leading-5 text-[color:var(--utility-foreground)]"
    >
      <p className="m-0 min-w-0 flex-1 basis-56">{noticeText(kind, name)}</p>
      <div className="flex flex-wrap items-center gap-1.5">
        {kind === 'blocked' ? action('Unblock', onUnblock) : null}
        {kind === 'incoming' ? [action('Accept', onAccept), action('Decline', onDecline), action('Block', onBlock, true)] : null}
        {kind === 'outgoing' ? action('Withdraw request', onWithdraw) : null}
        {kind === 'none' ? [action('Send contact request', onSendRequest), action('Block', onBlock, true)] : null}
      </div>
      {error ? <p aria-live="polite" className="app-error-text m-0 basis-full text-[12px] text-[color:var(--app-transient-danger-text)]">{error}</p> : null}
    </div>
  );
}
