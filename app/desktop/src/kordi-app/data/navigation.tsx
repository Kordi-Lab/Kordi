import type { ComponentType } from 'react';
import { Factory, MessageSquare, Users } from 'lucide-react';

import type { NavId } from '../types';

type NavItem = { id: NavId; label: string; icon: ComponentType<{ className?: string }> };

export const navItems: NavItem[] = [
  { id: 'chats', label: 'Chats', icon: MessageSquare },
  { id: 'contacts', label: 'Contacts', icon: Users },
  { id: 'agents', label: 'Factory', icon: Factory },
];

export function normalizeNavIdForCloud(navId: NavId): NavId {
  return navItems.some((item) => item.id === navId) ? navId : 'chats';
}

export const navAccentClasses: Record<NavId, string> = {
  chats: 'text-cyan-50',
  contacts: 'text-emerald-300',
  projects: 'text-cyan-50',
  agents: 'text-violet-50',
  bridge: 'text-cyan-50',
  settings: 'text-cyan-50',
};
