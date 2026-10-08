import { Bell, KeyRound, Laptop, Palette, Plug, User } from 'lucide-react';

import type { SettingsNavGroup } from '@/kordi-app/components';

export type CloudAccountSettingsTabId = 'profile' | 'devices' | 'auth' | 'notifications' | 'connectors' | 'appearance';

export function cloudAccountSettingsNavGroups({ connectorsAvailable }: { connectorsAvailable: boolean }): Array<SettingsNavGroup<CloudAccountSettingsTabId>> {
  return [
    {
      label: 'Account',
      items: [
        { id: 'profile', label: 'Profile', icon: User, keywords: ['name', 'avatar', 'sign out'] },
        { id: 'devices', label: 'Active sessions', icon: Laptop, keywords: ['devices'] },
      ],
    },
    {
      label: 'Settings',
      items: [
        { id: 'auth', label: 'Authentication', icon: KeyRound, keywords: ['providers', 'accounts', 'api key', 'omp'] },
        { id: 'notifications', label: 'Notifications', icon: Bell, keywords: ['alerts', 'sound', 'badge'] },
        ...(connectorsAvailable
          ? [{ id: 'connectors' as const, label: 'Connectors', icon: Plug, keywords: ['gmail', 'calendar', 'github', 'slack', 'services', 'integrations', 'mac'] }]
          : []),
        { id: 'appearance', label: 'Appearance', icon: Palette, keywords: ['theme', 'dark', 'light', 'chat', 'threads', 'message layout'] },
      ],
    },
  ];
}
