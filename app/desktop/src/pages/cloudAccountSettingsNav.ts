import { Ban, Bell, Brain, Gauge, KeyRound, Laptop, Palette, Plug, User } from 'lucide-react';

import type { SettingsNavGroup } from '@/kordi-app/components';

export type CloudAccountSettingsTabId = 'profile' | 'devices' | 'blocked' | 'auth' | 'notifications' | 'connectors' | 'memory' | 'usage' | 'appearance';

export function cloudAccountSettingsNavGroups({
  connectorsAvailable,
  memoryAvailable = false,
  blockedAvailable = false,
}: {
  connectorsAvailable: boolean;
  memoryAvailable?: boolean;
  blockedAvailable?: boolean;
}): Array<SettingsNavGroup<CloudAccountSettingsTabId>> {
  return [
    {
      label: 'Account',
      items: [
        { id: 'profile', label: 'Profile', icon: User, keywords: ['name', 'avatar', 'sign out'] },
        { id: 'devices', label: 'Active sessions', icon: Laptop, keywords: ['devices'] },
        ...(blockedAvailable ? [{ id: 'blocked' as const, label: 'Blocked', icon: Ban, keywords: ['block', 'unblock', 'report', 'privacy'] }] : []),
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
        ...(memoryAvailable
          ? [{ id: 'memory' as const, label: 'Memory', icon: Brain, keywords: ['lessons', 'remember', 'forget', 'privacy'] }]
          : []),
        { id: 'usage', label: 'Usage', icon: Gauge, keywords: ['limits', 'runs', 'spend', 'quota', 'system agent', 'grounding'] },
        { id: 'appearance', label: 'Appearance', icon: Palette, keywords: ['theme', 'dark', 'light', 'chat', 'threads', 'message layout'] },
      ],
    },
  ];
}
