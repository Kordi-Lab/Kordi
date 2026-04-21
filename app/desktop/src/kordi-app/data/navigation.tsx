import type { ComponentType } from 'react';
import { Bot, Layers3, MessageSquare, Network, Settings, Users } from 'lucide-react';

import type { NavId } from '../types';

export const navItems: Array<{ id: NavId; label: string; icon: ComponentType<{ className?: string }> }> = [
  { id: 'chats', label: 'Chats', icon: MessageSquare },
  { id: 'projects', label: 'Projects', icon: Layers3 },
  { id: 'contacts', label: 'Contacts', icon: Users },
  { id: 'agents', label: 'Agents', icon: Bot },
  { id: 'bridge', label: 'Bridge', icon: Network },
  { id: 'settings', label: 'Settings', icon: Settings },
];

export const navAccentClasses: Record<NavId, string> = {
  chats: 'text-cyan-50',
  contacts: 'text-emerald-300',
  projects: 'text-cyan-50',
  agents: 'text-violet-50',
  bridge: 'text-cyan-50',
  settings: 'text-cyan-50',
};
