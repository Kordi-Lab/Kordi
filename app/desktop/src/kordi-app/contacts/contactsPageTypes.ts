import type { ReactNode } from 'react';

import type { AddContactLookupResult } from '@/pages/ChatCreateDialog';
import type { Contact, ContactClass, ContactRequest } from '../types';

export type ContactGroup = { id: ContactClass; label: string; items: Contact[] };

export type ContactOverlayMode = 'contact' | 'request' | null;

export type ContactsPageProps = {
  filteredGroupedContacts: ContactGroup[];
  addableContacts?: Contact[];
  isContactRequestsOpen: boolean;
  onToggleRequests: () => void;
  contactRequests: ContactRequest[];
  activeContactRequestId: string;
  /** Opens a pending request in the detail pane, where Accept and Reject live. */
  onSelectRequest?: (request: ContactRequest) => void;
  onAcceptRequest?: (request: ContactRequest) => Promise<void> | void;
  onRejectRequest?: (request: ContactRequest) => Promise<void> | void;
  onAddContactByNodeId?: (nodeId: string) => Promise<void> | void;
  onLookupContact?: (idOrEmail: string) => Promise<AddContactLookupResult | null>;
  contactSearch: string;
  onContactSearchChange: (value: string) => void;
  expandedContactGroups: Record<ContactClass, boolean>;
  onToggleGroup: (groupId: ContactClass) => void;
  activeContactId: string;
  onSelectContact: (groupId: ContactClass, contactId: string) => void;
  contactOverlayMode: ContactOverlayMode;
  activeContact: Contact;
  activeContactRequest?: ContactRequest;
  onCloseOverlay: () => void;
  getStatusBadgeClass: (value: string) => string;
  onMessageContact?: (contact: Contact) => void;
  onRemoveContact?: (contact: Contact) => Promise<void> | void;
  /** Optional rows pinned above the request inbox at the top of the list column. */
  leadingListItems?: ReactNode;
  /**
   * Custom detail content, such as the page for a pinned leading row. When set it replaces the
   * contact or request detail; the caller clears contact selection while it is shown. Narrow
   * windows show it in place of the list, and Escape calls `onCloseOverlay`.
   */
  leadingDetail?: ReactNode;
};
