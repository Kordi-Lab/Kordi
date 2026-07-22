import { lazy, Suspense, type ComponentProps } from 'react';

import { ContactsPage } from '@/kordi-app/pages';
import type { AgentsPageProps } from '@/kordi-app/agents/model';
import type { NavId } from '@/kordi-app/types';
import { ChatsPage } from '@/pages/ChatsPage';
import { CloudContactsAdapter } from '@/features/cloud/CloudContactsAdapter';
import type { UseCloudSessionResult } from '@/features/cloud/useCloudSession';

const AgentsPage = lazy(() => import('@/kordi-app/agents/AgentsPage').then((module) => ({
  default: module.AgentsPage,
})));

type MainContentSwitchProps = {
  activeNav: NavId;
  cloudSession: UseCloudSessionResult;
  contactsPageProps: ComponentProps<typeof ContactsPage>;
  agentsPageProps: AgentsPageProps;
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
      return (
        <Suspense fallback={<div className="h-full w-full" aria-busy="true" />}>
          <AgentsPage {...agentsPageProps} />
        </Suspense>
      );
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
