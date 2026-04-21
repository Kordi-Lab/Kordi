import type { ComponentProps } from 'react';

import { AgentsPage, ContactsPage } from '@/kordi-app/pages';
import type { NavId } from '@/kordi-app/types';
import { BridgeConfigPage } from '@/pages/BridgeConfigPage';
import { ChatsPage } from '@/pages/ChatsPage';
import { ProjectsPage } from '@/pages/ProjectsPage';
import { SettingsPage } from '@/pages/SettingsPage';

type MainContentSwitchProps = {
  activeNav: NavId;
  contactsPageProps: ComponentProps<typeof ContactsPage>;
  agentsPageProps: ComponentProps<typeof AgentsPage>;
  bridgePageProps: ComponentProps<typeof BridgeConfigPage>;
  settingsPageProps: ComponentProps<typeof SettingsPage>;
  projectsPageProps: ComponentProps<typeof ProjectsPage>;
  chatsPageProps: ComponentProps<typeof ChatsPage>;
};

export function MainContentSwitch({
  activeNav,
  contactsPageProps,
  agentsPageProps,
  bridgePageProps,
  settingsPageProps,
  projectsPageProps,
  chatsPageProps,
}: MainContentSwitchProps) {
  switch (activeNav) {
    case 'contacts':
      return <ContactsPage {...contactsPageProps} />;
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
