import { ContactRequestRow } from '../components';
import type { ContactRequest } from '../types';
import { ContactsListSection } from './ContactsListSection';
import type { ContactRequestActions } from './useContactsPageState';

/** Incoming and outgoing pending requests as one "Requests" section of compact rows. */
export function ContactsRequestActivity({
  incomingContactRequests,
  outgoingContactRequests,
  activeContactRequestId,
  isContactRequestsOpen,
  onToggleRequests,
  onSelectRequest,
  requestActions,
}: {
  incomingContactRequests: ContactRequest[];
  outgoingContactRequests: ContactRequest[];
  activeContactRequestId: string;
  isContactRequestsOpen: boolean;
  onToggleRequests: () => void;
  onSelectRequest?: (request: ContactRequest) => void;
  requestActions: ContactRequestActions;
}) {
  const requestCount = incomingContactRequests.length + outgoingContactRequests.length;
  if (requestCount === 0) return null;

  return (
    <ContactsListSection
      label="Requests"
      count={requestCount}
      expanded={isContactRequestsOpen}
      onToggle={onToggleRequests}
      className="app-contacts-request-activity"
    >
      {[...incomingContactRequests, ...outgoingContactRequests].map((request) => (
        <ContactRequestRow
          key={request.id}
          request={request}
          active={activeContactRequestId === request.id}
          onSelect={onSelectRequest ? () => onSelectRequest(request) : undefined}
          onAccept={requestActions.canAccept ? () => { void requestActions.submit(request, 'accept'); } : undefined}
          actionState={requestActions.stateFor(request)}
        />
      ))}
      {requestActions.error ? (
        <div className="app-error-text app-contacts-error mx-2 py-1 text-[12px] leading-5" aria-live="polite">
          {requestActions.error}
        </div>
      ) : null}
    </ContactsListSection>
  );
}
