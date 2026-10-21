import { useRef } from 'react';
import { createPortal } from 'react-dom';

import { useSessionPanelSlot } from '@/app/sessionPanelSlot';

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
    contactProfileHost,
    contactMute,
    onOpenAgentSettings,
    sharedConversationFor,
    leadingDetail,
  } = props;
  const rootRef = useRef<HTMLDivElement>(null);
  const slot = useSessionPanelSlot();
  // With the list in the sidebar the detail always has the page to itself.
  const isNarrow = useIsNarrowContainer(rootRef, CONTACTS_SPLIT_MIN_WIDTH) && !slot;
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
    contactProfileHost,
    contactMute,
    onOpenAgentSettings,
    sharedConversationFor,
    requestActions,
  } : null;

  const listProps = { ...props, requests, requestActions, fullWidth: isNarrow };

  return (
    <div ref={rootRef} className={cn('app-contacts-page relative flex h-full min-h-0 min-w-0 flex-1', isNarrow && 'is-narrow')}>
      {slot
        ? createPortal(<ContactsListColumn {...listProps} inSidebar />, slot)
        : isNarrow && hasLeadingDetail ? null : <ContactsListColumn {...listProps} inSidebar={false} />}
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
