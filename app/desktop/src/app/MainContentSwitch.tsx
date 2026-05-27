import type { ComponentProps } from 'react';

import { AgentsPage, ContactsPage } from '@/kordi-app/pages';
import type { NavId } from '@/kordi-app/types';
import { BridgeConfigPage } from '@/pages/BridgeConfigPage';
import { ChatsPage } from '@/pages/ChatsPage';
import { ProjectsPage } from '@/pages/ProjectsPage';
import { SettingsPage } from '@/pages/SettingsPage';
import { CloudContactsAdapter } from '@/features/cloud/CloudContactsAdapter';
import { currentKordiEdition } from '@/features/cloud/edition';
import type { UseCloudSessionResult } from '@/features/cloud/useCloudSession';

type MainContentSwitchProps = {
  activeNav: NavId;
  cloudSession: UseCloudSessionResult;
  contactsPageProps: ComponentProps<typeof ContactsPage>;
  agentsPageProps: ComponentProps<typeof AgentsPage>;
  bridgePageProps: ComponentProps<typeof BridgeConfigPage>;
  settingsPageProps: ComponentProps<typeof SettingsPage>;
  projectsPageProps: ComponentProps<typeof ProjectsPage>;
  chatsPageProps: ComponentProps<typeof ChatsPage>;
};

export function MainContentSwitch({
  activeNav,
  cloudSession,
  contactsPageProps,
  agentsPageProps,
  bridgePageProps,
  settingsPageProps,
  projectsPageProps,
  chatsPageProps,
}: MainContentSwitchProps) {
  switch (activeNav) {
    case 'contacts':
      return <ContactsRoute cloudSession={cloudSession} contactsPageProps={contactsPageProps} />;
    case 'agents':
      return <AgentsPage {...agentsPageProps} />;
    case 'bridge':
      return <BridgeConfigPage {...bridgePageProps} />;
    case 'settings':
      return <SettingsPage {...settingsPageProps} />;
    case 'projects':
      return <ProjectsPage {...projectsPageProps} />;
    case 'chats':
    default:
      return <ChatsPage {...chatsPageProps} />;
  }
}

// Cloud-aware wrapper for the contacts route. In local edition this is
// a pass-through; in cloud edition it overlays the cloud contact graph
// (contacts + request inbox + send/accept/reject) on top of the
// existing ContactsPage shell.
function ContactsRoute({
  cloudSession,
  contactsPageProps,
}: {
  cloudSession: UseCloudSessionResult;
  contactsPageProps: ComponentProps<typeof ContactsPage>;
}) {
  const edition = currentKordiEdition();
  if (edition === 'cloud') {
    if (!cloudSession.account) {
      // Bootstrapping the cloud session — render an empty placeholder
      // shell instead of falling back to the local ContactsPage, which
      // would show local Bridge-flavoured data and confuse cloud users.
      return <ContactsPage {...contactsPageProps} filteredGroupedContacts={[]} contactRequests={[]} addableContacts={[]} />;
    }
    return <CloudContactsAdapter account={cloudSession.account} contactsPageProps={contactsPageProps} />;
  }
  return <ContactsPage {...contactsPageProps} />;
}
