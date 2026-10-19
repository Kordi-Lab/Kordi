import { useRef } from 'react';

import { cn } from '@/lib/utils';
import { ContactDetailDialog, ContactDetailEmpty, ContactDetailPane } from './ContactDetailPane';
import { ContactsListColumn } from './ContactsListColumn';
import type { ContactsPageProps } from './contactsPageTypes';
import {
  useContactRequestActions,
  useEscapeToDeselect,
  useIsNarrowContainer,
  usePartitionedContactRequests,
  useSelectedContactRequest,
} from './useContactsPageState';

/** Below this page width the detail falls back to a modal over the full-width list. */
const CONTACTS_SPLIT_MIN_WIDTH = 720;

export function ContactsPage(props: ContactsPageProps) {
  const {
    contactOverlayMode,
    activeContact,
    activeContactRequest,
    onCloseOverlay,
    onMessageContact,
    onRemoveContact,
    leadingDetail,
  } = props;
  const rootRef = useRef<HTMLDivElement>(null);
  const isNarrow = useIsNarrowContainer(rootRef, CONTACTS_SPLIT_MIN_WIDTH);
  const requests = usePartitionedContactRequests(props.contactRequests);
  const requestActions = useContactRequestActions(props.onAcceptRequest, props.onRejectRequest);
  const selectedRequest = useSelectedContactRequest(props.contactRequests, props.activeContactRequestId, activeContactRequest);
  const detailMode = contactOverlayMode === 'request' && !selectedRequest ? null : contactOverlayMode;
  const hasLeadingDetail = leadingDetail !== undefined && leadingDetail !== null && leadingDetail !== false;
  useEscapeToDeselect(
    hasLeadingDetail || (Boolean(detailMode) && !(detailMode === 'request' && requestActions.busy)),
    onCloseOverlay,
  );

  const detailProps = detailMode && !hasLeadingDetail ? {
    mode: detailMode,
    activeContact,
    activeContactRequest: selectedRequest,
    onCloseOverlay,
    onMessageContact,
    onRemoveContact,
    requestActions,
  } : null;

  return (
    <div ref={rootRef} className={cn('app-contacts-page relative flex h-full min-h-0 min-w-0 flex-1', isNarrow && 'is-narrow')}>
      {isNarrow && hasLeadingDetail ? null : (
        <ContactsListColumn {...props} requests={requests} requestActions={requestActions} fullWidth={isNarrow} />
      )}
      {hasLeadingDetail ? (
        <div className="app-contacts-detail-pane app-contacts-leading-detail relative flex min-h-0 min-w-0 flex-1 flex-col">
          {leadingDetail}
        </div>
      ) : null}
      {!isNarrow && !hasLeadingDetail && (detailProps ? <ContactDetailPane {...detailProps} /> : <ContactDetailEmpty />)}
      {isNarrow && detailProps ? <ContactDetailDialog {...detailProps} /> : null}
    </div>
  );
}
