import type { ComponentProps } from 'react';

import { AgentsPage, ContactsPage } from '@/kordi-app/pages';
import type { NavId } from '@/kordi-app/types';
import { ChatsPage } from '@/pages/ChatsPage';
import { CloudContactsAdapter } from '@/features/cloud/CloudContactsAdapter';
import type { UseCloudSessionResult } from '@/features/cloud/useCloudSession';

type MainContentSwitchProps = {
  activeNav: NavId;
  cloudSession: UseCloudSessionResult;
  contactsPageProps: ComponentProps<typeof ContactsPage>;
  agentsPageProps: ComponentProps<typeof AgentsPage>;
  chatsPageProps: ComponentProps<typeof ChatsPage>;
};

export function MainContentSwitch({
  activeNav,
  cloudSession,
  contactsPageProps,
  agentsPageProps,
  chatsPageProps,
}: MainContentSwitchProps) {
  switch (activeNav) {
    case 'contacts':
      return <ContactsRoute cloudSession={cloudSession} contactsPageProps={contactsPageProps} />;
    case 'agents':
      return <AgentsPage {...agentsPageProps} />;
    case 'chats':
    default:
      return <ChatsPage {...chatsPageProps} />;
  }
}

function ContactsRoute({
  cloudSession,
  contactsPageProps,
}: {
  cloudSession: UseCloudSessionResult;
  contactsPageProps: ComponentProps<typeof ContactsPage>;
}) {
  if (!cloudSession.account) {
    return <ContactsPage {...contactsPageProps} filteredGroupedContacts={[]} contactRequests={[]} addableContacts={[]} />;
  }
  return <CloudContactsAdapter account={cloudSession.account} contactsPageProps={contactsPageProps} />;
}
