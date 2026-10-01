import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

import { safetyErrorMessage } from '@/features/safety/safetyCopy';

import { ContactRequestTime } from '../components';
import { IdentityAvatar } from '../components/IdentityAvatar';
import { sentInviteDisplayName } from '../contactPresentation';
import type { ContactRequest } from '../types';

type SentInvitesSectionProps = {
  requests: ContactRequest[];
  /** Present only when the server supports withdrawing a request. */
  onWithdrawRequest?: (request: ContactRequest) => Promise<void> | void;
};

export function SentInvitesSection({ requests, onWithdrawRequest }: SentInvitesSectionProps) {
  const [isSentInvitesOpen, setIsSentInvitesOpen] = useState(false);
  const [withdrawingId, setWithdrawingId] = useState<string | null>(null);
  const [withdrawError, setWithdrawError] = useState('');
  const sentInvitesSummary = `${requests.length} awaiting approval`;

  const withdraw = async (request: ContactRequest) => {
    if (!onWithdrawRequest || withdrawingId) return;
    setWithdrawingId(request.id);
    setWithdrawError('');
    try {
      await onWithdrawRequest(request);
    } catch (error) {
      setWithdrawError(safetyErrorMessage(error, "Couldn't withdraw the request. Try again."));
    } finally {
      setWithdrawingId(null);
    }
  };

  return (
    <section className="app-contacts-sent-invites-row" aria-label="Sent contact invites">
      <button
        type="button"
        onClick={() => setIsSentInvitesOpen((open) => !open)}
        className="app-contacts-section-button flex w-full items-center justify-between gap-3 px-3 py-3 text-left transition-none"
        aria-expanded={isSentInvitesOpen}
      >
        <div className="flex min-w-0 items-center gap-3">
          {isSentInvitesOpen ? (
            <ChevronDown className="h-4 w-4 shrink-0 text-slate-300" />
          ) : (
            <ChevronRight className="h-4 w-4 shrink-0 text-slate-300" />
          )}
          <div className="truncate text-[12px] font-medium leading-5 text-white">Sent invites</div>
        </div>
        <div className="shrink-0 text-[11px] leading-4 text-slate-400">{sentInvitesSummary}</div>
      </button>
      {isSentInvitesOpen && (
        <div className="grid gap-1">
          {requests.map((request) => (
            <div key={request.id} className="app-contacts-sent-invite-item w-full px-3 py-2.5 text-white">
              <div className="flex items-center gap-3">
                <IdentityAvatar
                  kind="human"
                  seed={request.avatarSeed ?? request.targetNodeId ?? request.id}
                  name={sentInviteDisplayName(request)}
                  imageUrl={request.profileImageUrl}
                  className="h-9 w-9 border border-white/10"
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium leading-5">{sentInviteDisplayName(request)}</div>
                  <div className="flex items-center gap-1.5 truncate text-[11.5px] leading-4 text-slate-400">
                    <span>Awaiting approval</span>
                    <span aria-hidden="true">·</span>
                    <ContactRequestTime value={request.time} />
                  </div>
                </div>
                {onWithdrawRequest ? (
                  <button
                    type="button"
                    className="app-contacts-action-chip app-button-quiet h-8 shrink-0 rounded-full px-3 text-[12px]"
                    disabled={Boolean(withdrawingId)}
                    aria-label={`Withdraw request to ${sentInviteDisplayName(request)}`}
                    onClick={() => { void withdraw(request); }}
                  >
                    {withdrawingId === request.id ? 'Withdrawing…' : 'Withdraw'}
                  </button>
                ) : null}
              </div>
            </div>
          ))}
          {withdrawError ? (
            <div className="app-error-text px-3 py-1 text-[12px] leading-5 text-rose-200" aria-live="polite">{withdrawError}</div>
          ) : null}
        </div>
      )}
    </section>
  );
}
