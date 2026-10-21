import { useMemo, useState } from 'react';

import { ContactProfileSharedPageView } from '@/pages/ContactProfileSharedPages';
import {
  collectContactProfileSharedItems,
  sharedConversationIsComplete,
  type ContactProfileSharedPage,
} from '@/pages/contactProfileSharedItems';
import type { Contact, Conversation } from '../types';

export type ContactSharedCounts = { photos: number; files: number; links: number };

/**
 * Shared pages for the Contacts pane and the chat Info tab. They exist only while the client
 * holds the whole direct chat; otherwise `counts` is null and the rows keep the server counts.
 */
export function useContactSharedPages(
  contact: Contact,
  sharedConversationFor?: (contact: Contact) => Conversation | null,
) {
  const conversation = sharedConversationFor?.(contact) ?? null;
  const items = useMemo(
    () => sharedConversationIsComplete(conversation) ? collectContactProfileSharedItems(conversation?.messages) : null,
    [conversation],
  );
  const [openPage, setOpenPage] = useState<ContactProfileSharedPage | null>(null);
  const counts: ContactSharedCounts | null = items
    ? { photos: items.photos.length, files: items.files.length, links: items.links.length }
    : null;
  const page = items && openPage ? (
    <ContactProfileSharedPageView page={openPage} items={items} variant="pane" onBack={() => setOpenPage(null)} />
  ) : null;
  return { counts, page, open: items ? setOpenPage : undefined };
}
