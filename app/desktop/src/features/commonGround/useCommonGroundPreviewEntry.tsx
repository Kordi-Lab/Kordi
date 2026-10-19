import { useState } from 'react';
import type { ReactNode } from 'react';

import { CommonGroundContactsRow } from './CommonGroundContactsRow';
import { CommonGroundPreviewFrame } from './CommonGroundPreviewFrame';

/**
 * Development builds only: `VITE_KORDI_PREVIEW_COMMON_GROUND=1` pins the Common ground row in the
 * real Contacts page. Its detail embeds the `tests/visual` preview page, which Vite serves in
 * development and which talks to the loopback demo server, until the React feature lands.
 */
export const commonGroundPreviewEnabled = Boolean(import.meta.env?.DEV) && import.meta.env?.VITE_KORDI_PREVIEW_COMMON_GROUND === '1';

type ContactsSelectionHandlers<Contact, Request> = {
  onSelectContact: (groupId: Contact, contactId: string) => void;
  onSelectRequest?: (request: Request) => void;
  onCloseOverlay: () => void;
};

export type CommonGroundPreviewEntry<Contact, Request> = ContactsSelectionHandlers<Contact, Request> & {
  leadingListItems?: ReactNode;
  leadingDetail?: ReactNode;
};

export function useCommonGroundPreviewEntry<Contact, Request>(
  handlers: ContactsSelectionHandlers<Contact, Request>,
  displayName?: string,
): CommonGroundPreviewEntry<Contact, Request> {
  const [selected, setSelected] = useState(false);
  if (!commonGroundPreviewEnabled) return handlers;
  const { onSelectRequest } = handlers;
  return {
    onSelectContact: (groupId, contactId) => {
      setSelected(false);
      handlers.onSelectContact(groupId, contactId);
    },
    onSelectRequest: onSelectRequest ? (request) => {
      setSelected(false);
      onSelectRequest(request);
    } : undefined,
    onCloseOverlay: () => {
      setSelected(false);
      handlers.onCloseOverlay();
    },
    leadingListItems: <CommonGroundContactsRow selected={selected} onSelect={() => setSelected(true)} />,
    leadingDetail: selected ? <CommonGroundPreviewFrame displayName={displayName} /> : null,
  };
}
