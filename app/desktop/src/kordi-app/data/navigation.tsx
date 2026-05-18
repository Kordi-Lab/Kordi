import type { ComponentType } from 'react';
import { Bot, Layers3, MessageSquare, Settings, Users } from 'lucide-react';

import type { KordiEdition } from '@/features/cloud/edition';
import { currentKordiEdition } from '@/features/cloud/edition';
import type { NavId } from '../types';

type NavItem = { id: NavId; label: string; icon: ComponentType<{ className?: string }> };

export const allNavItems: NavItem[] = [
  { id: 'chats', label: 'Chats', icon: MessageSquare },
  { id: 'projects', label: 'Projects', icon: Layers3 },
  { id: 'contacts', label: 'Contacts', icon: Users },
  { id: 'agents', label: 'Agents', icon: Bot },
  { id: 'settings', label: 'Settings', icon: Settings },
];

export function navItemsForEdition(edition: KordiEdition): NavItem[] {
  return edition === 'cloud'
    ? allNavItems.filter((item) => item.id !== 'projects' && item.id !== 'settings')
    : allNavItems;
}

export function normalizeNavIdForEdition(edition: KordiEdition, navId: NavId): NavId {
  if (edition === 'cloud' && (navId === 'projects' || navId === 'settings')) return 'chats';
  return navId;
}

export const navItems: NavItem[] = navItemsForEdition(currentKordiEdition());

export const navAccentClasses: Record<NavId, string> = {
  chats: 'text-cyan-50',
  contacts: 'text-emerald-300',
  projects: 'text-cyan-50',
  agents: 'text-violet-50',
  bridge: 'text-cyan-50',
  settings: 'text-cyan-50',
};
