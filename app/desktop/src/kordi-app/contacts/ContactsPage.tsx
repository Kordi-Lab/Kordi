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
  } = props;
  const rootRef = useRef<HTMLDivElement>(null);
  const isNarrow = useIsNarrowContainer(rootRef, CONTACTS_SPLIT_MIN_WIDTH);
  const requests = usePartitionedContactRequests(props.contactRequests);
  const requestActions = useContactRequestActions(props.onAcceptRequest, props.onRejectRequest);
  const detailMode = contactOverlayMode === 'request' && !activeContactRequest ? null : contactOverlayMode;
  useEscapeToDeselect(Boolean(detailMode) && !(detailMode === 'request' && requestActions.busy), onCloseOverlay);

  const detailProps = detailMode ? {
    mode: detailMode,
    activeContact,
    activeContactRequest,
    onCloseOverlay,
    onMessageContact,
    onRemoveContact,
    requestActions,
  } : null;

  return (
    <div ref={rootRef} className={cn('app-contacts-page relative flex h-full min-h-0 min-w-0 flex-1', isNarrow && 'is-narrow')}>
      <ContactsListColumn {...props} requests={requests} requestActions={requestActions} fullWidth={isNarrow} />
      {!isNarrow && (detailProps ? <ContactDetailPane {...detailProps} /> : <ContactDetailEmpty />)}
      {isNarrow && detailProps ? <ContactDetailDialog {...detailProps} /> : null}
    </div>
  );
}
