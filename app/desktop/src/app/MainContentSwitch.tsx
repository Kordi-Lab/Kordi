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

const DigestPage = lazy(() => import('@/features/digest/DigestPage'));

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
    case 'digest':
      return <Suspense fallback={<div aria-busy="true">Loading digest…</div>}>{cloudSession.account ? <DigestPage key={cloudSession.account.accountId} accountId={cloudSession.account.accountId} /> : <div className="p-6">Sign in to open your digest.</div>}</Suspense>;
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
