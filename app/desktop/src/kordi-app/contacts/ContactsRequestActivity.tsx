import { useState } from 'react';
import { ChevronDown, ChevronRight, Inbox, Send } from 'lucide-react';

import { ContactRequestRow, ContactRequestTime } from '../components';
import { IdentityAvatar } from '../components/IdentityAvatar';
import { sentInviteDisplayName } from '../contactPresentation';
import type { ContactRequest } from '../types';
import type { ContactRequestActions } from './useContactsPageState';

function Disclosure({ open }: { open: boolean }) {
  return open
    ? <ChevronDown className="app-contacts-muted h-4 w-4 shrink-0" aria-hidden="true" />
    : <ChevronRight className="app-contacts-muted h-4 w-4 shrink-0" aria-hidden="true" />;
}

export function ContactsRequestActivity({
  incomingContactRequests,
  outgoingContactRequests,
  activeContactRequestId,
  isContactRequestsOpen,
  onToggleRequests,
  requestActions,
}: {
  incomingContactRequests: ContactRequest[];
  outgoingContactRequests: ContactRequest[];
  activeContactRequestId: string;
  isContactRequestsOpen: boolean;
  onToggleRequests: () => void;
  requestActions: ContactRequestActions;
}) {
  const [isSentInvitesOpen, setIsSentInvitesOpen] = useState(false);
  const pendingRequestCount = incomingContactRequests.length;
  const sentInviteCount = outgoingContactRequests.length;
  if (pendingRequestCount === 0 && sentInviteCount === 0) return null;

  const requestInboxSummary = `Review ${pendingRequestCount} pending ${pendingRequestCount === 1 ? 'request' : 'requests'}.`;
  const sentInvitesSummary = `${sentInviteCount} awaiting approval`;

  return (
    <div className="app-contacts-request-activity grid gap-0.5">
      {pendingRequestCount > 0 && (
        <section aria-label="Incoming contact requests">
          <button
            type="button"
            onClick={onToggleRequests}
            className="app-contacts-section-button app-contacts-request-row flex w-full items-center gap-3 text-left"
            aria-expanded={isContactRequestsOpen}
          >
            <span className="app-contacts-row-icon" aria-hidden="true"><Inbox className="h-[18px] w-[18px]" /></span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[14px] font-semibold leading-5">New requests</span>
              <span className="app-contacts-muted block truncate text-[12px] leading-4">{requestInboxSummary}</span>
            </span>
            <span className="app-badge-attention px-2 py-0.5 text-[10px] font-medium">{pendingRequestCount}</span>
            <Disclosure open={isContactRequestsOpen} />
          </button>
          {isContactRequestsOpen && (
            <div className="grid gap-1 pb-1 pt-0.5">
              {incomingContactRequests.map((request) => (
                <ContactRequestRow
                  key={request.id}
                  request={request}
                  active={activeContactRequestId === request.id}
                  onAccept={() => { void requestActions.submit(request, 'accept'); }}
                  onReject={() => { void requestActions.submit(request, 'reject'); }}
                  actionState={requestActions.stateFor(request)}
                />
              ))}
              {requestActions.error ? (
                <div className="app-error-text app-contacts-error mx-2 text-[12px] leading-5" aria-live="polite">
                  {requestActions.error}
                </div>
              ) : null}
            </div>
          )}
        </section>
      )}

      {sentInviteCount > 0 && (
        <section className="app-contacts-sent-invites-row" aria-label="Sent contact invites">
          <button
            type="button"
            onClick={() => setIsSentInvitesOpen((open) => !open)}
            className="app-contacts-section-button app-contacts-request-row flex w-full items-center gap-3 text-left"
            aria-expanded={isSentInvitesOpen}
          >
            <span className="app-contacts-row-icon" aria-hidden="true"><Send className="h-[17px] w-[17px]" /></span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[14px] font-semibold leading-5">Sent invites</span>
              <span className="app-contacts-muted block truncate text-[12px] leading-4">{sentInvitesSummary}</span>
            </span>
            <Disclosure open={isSentInvitesOpen} />
          </button>
          {isSentInvitesOpen && (
            <div className="grid gap-0.5 pb-1">
              {outgoingContactRequests.map((request) => (
                <div key={request.id} className="app-contacts-sent-invite-item flex w-full items-center gap-3 px-2.5 py-2">
                  <IdentityAvatar
                    kind="human"
                    seed={request.avatarSeed ?? request.targetNodeId ?? request.id}
                    name={sentInviteDisplayName(request)}
                    imageUrl={request.profileImageUrl}
                    cornerRadius="50%"
                    className="app-contacts-avatar h-10 w-10"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[14px] font-semibold leading-5">{sentInviteDisplayName(request)}</div>
                    <div className="app-contacts-muted flex items-center gap-1.5 truncate text-[12px] leading-4">
                      <span>Awaiting approval</span>
                      <span aria-hidden="true">·</span>
                      <ContactRequestTime value={request.time} />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
